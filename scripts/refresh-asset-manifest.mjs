import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Rewrites `ASSET_MANIFEST.json` from what is actually on disk (CLAUDE.md §21).
 *
 * The manifest is the record of what the pack contains, so it has to describe reality: it
 * still listed the cartoon `*.svg` backgrounds that were deleted and the byte counts of
 * rasters that have since been replaced. A manifest that disagrees with the directory is
 * worse than none, because it is trusted.
 *
 * Also records provenance for the replaced photography — §21 requires source metadata to
 * exist before production use.
 *
 *   node scripts/refresh-asset-manifest.mjs
 */

const ROOT = join(process.cwd(), 'public', 'assets', 'apron');
const MANIFEST = join(ROOT, 'ASSET_MANIFEST.json');

/** Every file under the pack, excluding the manifest and docs themselves. */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
      continue;
    }
    if (['ASSET_MANIFEST.json', 'README.md', 'DESIGN_TOKENS.css'].includes(entry.name)) continue;
    files.push(full);
  }

  return files;
}

const existing = JSON.parse(await readFile(MANIFEST, 'utf8'));
const found = (await walk(ROOT)).sort();

const files = [];
for (const full of found) {
  const info = await stat(full);
  files.push({
    path: relative(ROOT, full).split(sep).join('/'),
    bytes: info.size,
  });
}

const manifest = {
  version: existing.version ?? '1.0.0',
  fileCount: files.length,
  /**
   * Where the atmospheric photography came from. Recorded because §21 requires source
   * metadata before production use, and because "who owns this image" is a question that
   * gets asked long after the person who added it has moved on.
   */
  provenance: {
    '05_backgrounds/login-auth.webp': {
      source: 'Supplied for this project by the product owner (generative).',
      subject: 'Business jet at a hangar entrance, blue hour. Generic — not a named airport.',
      usage: 'Sign-in brand panel.',
    },
    '05_backgrounds/client-hero.webp': {
      source: 'Supplied for this project by the product owner (generative).',
      subject: 'Business jet on an apron at sunrise. Generic — not a named airport.',
      usage: 'Client composer hero.',
    },
    '05_backgrounds/ops-sidebar.webp': {
      source: 'Supplied for this project by the product owner (generative).',
      subject: 'Apron at sunrise, cropped tall.',
      usage: 'Operations sidebar atmosphere, ~14% opacity.',
    },
    '05_backgrounds/provider-sidebar.webp': {
      source: 'Supplied for this project by the product owner (generative).',
      subject: 'Aircraft and sunrise at an FBO, cropped tall.',
      usage: 'Provider sidebar atmosphere, ~14% opacity.',
    },
    '05_backgrounds/admin-sidebar.webp': {
      source: 'Supplied for this project by the product owner (generative).',
      subject: 'Hangar at blue hour, darkest crop.',
      usage: 'Admin sidebar atmosphere, ~14% opacity. The most restrained portal (§21).',
    },
  },
  /**
   * None of the imagery above depicts a specific real airport or FBO, and none of it is
   * ever captioned as one. Where a place must be identified, the product renders the ICAO,
   * IATA, name and stored coordinates as data beside the image.
   */
  imageryPolicy:
    'Atmospheric imagery is generic. A generic image is never presented as a photograph of ' +
    'a specific named airport or FBO; real identity is always rendered as structured data.',
  files,
};

await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`manifest refreshed — ${String(files.length)} files`);
