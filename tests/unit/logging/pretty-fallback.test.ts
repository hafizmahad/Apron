import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Logging must never take the application down (CLAUDE.md §28).
 *
 * This exists because of a real failure. `pino-pretty` is a devDependency — a developer
 * convenience, absent from the production image by design. The logger asked pino for it
 * whenever `LOG_PRETTY` was set, and the Docker container inherited `LOG_PRETTY=true` from
 * `.env`, so pino threw "unable to determine transport target for pino-pretty".
 *
 * Because `logger()` runs at the head of every server action, queue job and request, a
 * preference about log *formatting* became a broken application — and it broke only in the
 * image, never on a developer's machine, which is the worst place for a bug to hide.
 *
 * These are source assertions rather than behavioural ones: reproducing a missing module
 * inside the test process would mean unloading a package the rest of the suite uses.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('the pretty log transport is optional', () => {
  const source = read('src/lib/logging/index.ts');

  it('wraps the pretty transport in a try/catch', () => {
    // The `transport:` construction must sit inside a try block.
    const tryIndex = source.indexOf('try {');
    const transportIndex = source.indexOf("target: 'pino-pretty'");
    const catchIndex = source.indexOf('} catch', tryIndex);

    expect(tryIndex, 'no try block around the transport').toBeGreaterThan(-1);
    expect(transportIndex).toBeGreaterThan(tryIndex);
    expect(catchIndex).toBeGreaterThan(transportIndex);
  });

  it('falls back to a working logger rather than rethrowing', () => {
    const catchBlock = source.slice(source.indexOf('} catch'), source.indexOf('return pino(base);\n}'));

    // The catch must produce a logger, not swallow silently and not rethrow.
    expect(catchBlock).toMatch(/return\s+plain/);
    expect(catchBlock).not.toMatch(/throw/);
  });

  it('says why it fell back, so a silent downgrade is still visible', () => {
    expect(source).toMatch(/pino-pretty is not installed/i);
  });
});

describe('the production image cannot depend on a devDependency', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('keeps pino-pretty a devDependency', () => {
    // If somebody "fixes" this by promoting it to a dependency, the image grows for a
    // developer convenience. The fallback above is the right fix, so this pins the intent.
    expect(pkg.devDependencies['pino-pretty']).toBeDefined();
    expect(pkg.dependencies['pino-pretty']).toBeUndefined();
  });

  it('keeps pino itself a real dependency', () => {
    expect(pkg.dependencies['pino']).toBeDefined();
  });
});

describe('the container is not asked for pretty logs', () => {
  const compose = read('docker-compose.yml');

  it('defaults LOG_PRETTY to false for the image', () => {
    // Belt and braces alongside the fallback: a production container has no terminal to
    // pretty-print for, and its stdout is read by a log collector that wants JSON.
    expect(compose).toMatch(/LOG_PRETTY:\s*\$\{LOG_PRETTY:-false\}/);
  });
});
