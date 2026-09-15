import { cp, access, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Makes `.next/standalone` actually runnable.
 *
 * Next.js's standalone output deliberately OMITS `.next/static` and `public/`: it assumes a
 * container image or a CDN will place them. Running `node .next/standalone/server.js`
 * straight after a build therefore serves pages whose every stylesheet, script chunk and
 * image 404s — the HTML arrives, nothing else does, and the application looks like an
 * unstyled backend with no interactivity.
 *
 * Nothing warns you. The server starts, pages return 200, and only a browser shows the
 * problem. So the copy is done here, as part of the build, rather than left as a step
 * somebody has to remember.
 *
 * The Dockerfile performs the equivalent copies in its own COPY layers (it cannot reuse
 * this script, because each stage copies from a different builder path), so the two must be
 * kept in step. `npm run verify:routing` now fetches the referenced assets and fails if they
 * are missing, which is what catches a drift between them.
 */

const ROOT = process.cwd();
const STANDALONE = join(ROOT, '.next', 'standalone');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(STANDALONE))) {
  console.error(
    '[standalone] .next/standalone does not exist. Run `npm run build` first ' +
      '(and check next.config.ts still sets output: "standalone").',
  );
  process.exit(1);
}

const copies = [
  { from: join(ROOT, '.next', 'static'), to: join(STANDALONE, '.next', 'static'), label: 'static' },
  { from: join(ROOT, 'public'), to: join(STANDALONE, 'public'), label: 'public' },
];

for (const { from, to, label } of copies) {
  if (!(await exists(from))) {
    console.error(`[standalone] ${from} is missing — the build did not complete.`);
    process.exit(1);
  }

  // Replace rather than merge, so a stale chunk from a previous build cannot linger and be
  // served alongside the current one.
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  console.log(`[standalone] copied ${label}`);
}

console.log('[standalone] ready — start it with: npm run start:standalone');
