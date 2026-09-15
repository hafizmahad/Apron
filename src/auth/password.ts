import '@/lib/server-guard';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getEnv } from '@/lib/config/env';
import { ApronError } from '@/lib/errors';

/**
 * Password hashing (ADR-006, CLAUDE.md §27).
 *
 * Argon2id is the default. The whole surface is these three functions, so swapping the
 * algorithm never touches a call site — which is the point: if a platform has no argon2
 * prebuilt binary, `PASSWORD_HASH_ALGO=scrypt` selects the Node built-in implementation
 * behind the identical interface.
 *
 * Both encodings are self-describing, so a hash produced under one algorithm keeps
 * verifying after the setting changes and `needsRehash()` tells the login path when to
 * transparently upgrade it.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * OWASP-aligned argon2id parameters: 19 MiB, 2 iterations, parallelism 1.
 * Raising memory or time later is safe — `needsRehash()` picks up the difference.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** scrypt fallback: N=2^16 with r=8, p=1, and headroom so Node does not refuse the job. */
const SCRYPT_PARAMS = { N: 65_536, r: 8, p: 1, keylen: 64, maxmem: 160 * 1024 * 1024 } as const;

const SCRYPT_PREFIX = '$scrypt$';

/** Loaded lazily so a platform without the native module can still run with scrypt. */
type Argon2Module = {
  hash: (password: string, options: Record<string, unknown>) => Promise<string>;
  verify: (hash: string, password: string) => Promise<boolean>;
  needsRehash: (hash: string, options: Record<string, unknown>) => boolean;
  argon2id: number;
};

let argon2Module: Argon2Module | undefined;

async function loadArgon2(): Promise<Argon2Module> {
  if (argon2Module !== undefined) return argon2Module;
  try {
    const loaded = (await import('argon2')) as unknown as { default?: Argon2Module } & Argon2Module;
    argon2Module = loaded.default ?? loaded;
    return argon2Module;
  } catch (error) {
    throw new ApronError(
      'config_invalid',
      'PASSWORD_HASH_ALGO is argon2id but the argon2 module could not be loaded. ' +
        'Set PASSWORD_HASH_ALGO=scrypt to use the Node built-in implementation.',
      { cause: error },
    );
  }
}

function selectedAlgorithm(): 'argon2id' | 'scrypt' {
  return getEnv().PASSWORD_HASH_ALGO;
}

/** Hashes a plaintext password with the configured algorithm. */
export async function hashPassword(plaintext: string): Promise<string> {
  assertPlausiblePassword(plaintext);

  if (selectedAlgorithm() === 'scrypt') {
    return hashWithScrypt(plaintext);
  }

  const argon2 = await loadArgon2();
  return argon2.hash(plaintext, { ...ARGON2_OPTIONS, type: argon2.argon2id });
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false for a wrong password and for a malformed stored hash; it never throws on
 * a bad credential, because the caller must not be able to distinguish the two cases from
 * an exception. A genuine configuration fault (missing argon2 module) does throw.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  if (storedHash === '' || plaintext === '') return false;

  if (storedHash.startsWith(SCRYPT_PREFIX)) {
    return verifyScrypt(storedHash, plaintext);
  }

  if (storedHash.startsWith('$argon2')) {
    const argon2 = await loadArgon2();
    try {
      return await argon2.verify(storedHash, plaintext);
    } catch {
      // argon2 throws on a malformed encoding; that is a failed verification, not a crash.
      return false;
    }
  }

  return false;
}

/**
 * True when the stored hash was produced by a different algorithm or weaker parameters
 * than the current configuration, so the login path can upgrade it after a successful
 * sign-in.
 */
export async function needsRehash(storedHash: string): Promise<boolean> {
  const algorithm = selectedAlgorithm();

  if (algorithm === 'scrypt') {
    if (!storedHash.startsWith(SCRYPT_PREFIX)) return true;
    const parts = storedHash.split('$');
    return parts[2] !== scryptParameterTag();
  }

  if (!storedHash.startsWith('$argon2id')) return true;
  const argon2 = await loadArgon2();
  return argon2.needsRehash(storedHash, { ...ARGON2_OPTIONS, type: argon2.argon2id });
}

function scryptParameterTag(): string {
  return `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
}

async function hashWithScrypt(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plaintext.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return `${SCRYPT_PREFIX}${scryptParameterTag()}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyScrypt(storedHash: string, plaintext: string): Promise<boolean> {
  // `$scrypt$N=...,r=...,p=...$<salt b64>$<hash b64>`
  const parts = storedHash.split('$');
  const parameters = parts[2];
  const saltPart = parts[3];
  const hashPart = parts[4];
  if (parameters === undefined || saltPart === undefined || hashPart === undefined) return false;

  const matched = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parameters);
  if (matched === null) return false;

  const [, rawN, rawR, rawP] = matched;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashPart, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = await scrypt(plaintext.normalize('NFKC'), Buffer.from(saltPart, 'base64'), expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });

  // Constant-time: a timing difference here leaks how much of the hash matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Guards against the two ways a hash call can go wrong before it starts: an empty
 * password, and an unbounded one used to burn CPU (argon2 and scrypt both cost real time,
 * so an unlimited length is a denial-of-service vector).
 */
function assertPlausiblePassword(plaintext: string): void {
  if (plaintext.length === 0) {
    throw new ApronError('validation_failed', 'Password must not be empty');
  }
  if (Buffer.byteLength(plaintext, 'utf8') > 1024) {
    throw new ApronError('validation_failed', 'Password must be at most 1024 bytes');
  }
}
