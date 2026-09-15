import '@/lib/server-guard';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { getEnv } from '@/lib/config/env';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';
import type { DocumentContentType } from '@/db/schema/enums';

/**
 * Document storage behind one interface (CLAUDE.md §19).
 *
 * Local development writes to disk; production writes to S3. Nothing above this interface
 * knows which, so moving from one to the other is configuration, not a rewrite.
 *
 * The storage key is generated here and never taken from user input. That is the whole
 * defence against path traversal: there is no code path where a caller-supplied string
 * becomes a filename. {@link assertWithinRoot} is the second line, checking the resolved
 * path really is inside the configured root before any read or write.
 */

export interface StoredObject {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
}

export interface StorageDriverApi {
  readonly name: 'filesystem' | 's3';
  put(key: string, body: Buffer, contentType: DocumentContentType): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/**
 * Builds a storage key.
 *
 * Shape: `documents/<requestId>/<kind>/<uuid>.<ext>`. The UUID means a regenerated
 * document never overwrites the previous version — the record of what was sent to a client
 * last Tuesday must not change because someone pressed the button again today.
 */
export function buildStorageKey(
  requestId: string,
  kind: string,
  contentType: DocumentContentType,
): string {
  return `documents/${requestId}/${kind}/${randomUUID()}.${extensionFor(contentType)}`;
}

function extensionFor(contentType: DocumentContentType): string {
  switch (contentType) {
    case 'application/pdf':
      return 'pdf';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'text/csv':
      return 'csv';
    case 'application/json':
      return 'json';
    case 'text/plain':
      return 'txt';
  }
}

/** A key we generated. Anything else is refused before it reaches the filesystem. */
const KEY_PATTERN = /^documents\/[0-9a-f-]{36}\/[a-z_]{3,40}\/[0-9a-f-]{36}\.[a-z]{3,4}$/;

function assertWellFormedKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new ApronError('validation_failed', 'That is not a valid storage key');
  }
}

// ---------------------------------------------------------------------------
// filesystem
// ---------------------------------------------------------------------------

class FilesystemStorage implements StorageDriverApi {
  readonly name = 'filesystem' as const;

  private get root(): string {
    return resolve(getEnv().DOCUMENT_STORAGE_PATH);
  }

  /**
   * Resolves a key to an absolute path and proves it stayed inside the root.
   *
   * `assertWellFormedKey` already rejects anything containing `..`, but this check is not
   * redundant: it is the invariant that survives someone later relaxing the pattern.
   */
  private pathFor(key: string): string {
    assertWellFormedKey(key);
    const root = this.root;
    const full = resolve(join(root, normalize(key)));

    if (full !== root && !full.startsWith(root + sep)) {
      logger().error({ key }, 'storage key resolved outside the storage root — refused');
      throw new ApronError('validation_failed', 'That is not a valid storage key');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);

    return {
      storageKey: key,
      byteSize: body.byteLength,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if (error instanceof ApronError) throw error;
      throw new ApronError('not_found', 'That document is no longer stored');
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      // Already gone is the desired end state. Anything else — a permission problem, a
      // read-only mount — is a real fault and must not be swallowed just because the
      // caller happened to be deleting.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger().error({ key }, 'could not remove a stored document');
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// s3
// ---------------------------------------------------------------------------

/**
 * The S3 driver is declared but deliberately not implemented yet.
 *
 * Phase 13 wires it with the AWS SDK once the bucket and its IAM policy exist in Terraform.
 * Until then it throws a configuration error naming exactly what is missing, rather than
 * silently writing to local disk on a production host and losing every document on the next
 * container replacement.
 */
class S3Storage implements StorageDriverApi {
  readonly name = 's3' as const;

  private fail(): never {
    throw new ApronError(
      'config_invalid',
      'DOCUMENT_STORAGE_DRIVER is s3, but the S3 driver is not implemented until Phase 13. ' +
        'Set DOCUMENT_STORAGE_DRIVER=filesystem for local and staging use.',
    );
  }

  async put(): Promise<StoredObject> {
    this.fail();
  }
  async get(): Promise<Buffer> {
    this.fail();
  }
  async remove(): Promise<void> {
    this.fail();
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

let driver: StorageDriverApi | undefined;

export function getStorage(): StorageDriverApi {
  if (driver === undefined) {
    driver = getEnv().DOCUMENT_STORAGE_DRIVER === 's3' ? new S3Storage() : new FilesystemStorage();
  }
  return driver;
}

export function resetStorageForTests(): void {
  driver = undefined;
}
