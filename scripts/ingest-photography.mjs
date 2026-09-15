import { readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Ingests the supplied aviation photography into the asset pack (CLAUDE.md §21).
 *
 * The originals shipped with the pack depicted a cartoon aircraft — a blob fuselage with
 * oval engines — which is on the brief's explicit "avoid" list. These replace them with
 * photorealistic private-aviation photography supplied for the project.
 *
 * Crops are chosen so the **negative space lands where the text does**: the sign-in panel
 * puts its wordmark and positioning copy on the left, so the frame is composed with open
 * sky there and the subject on the right. A background that fights the copy is worse than
 * no background.
 *
 * Provenance is recorded in the manifest (§21: source metadata before production use).
 * None of these is presented as a photograph of a specific named airport — they are
 * atmosphere, and the real ICAO/IATA, name and coordinates are always rendered as data
 * beside them.
 *
 *   node scripts/ingest-photography.mjs
 *
 * Re-runnable: it reads from SOURCE and writes deterministic output, so a re-run after a
 * crop tweak simply replaces the files.
 */

const SOURCE = 'C:/Users/hafiz/Downloads';
const OUT = join(process.cwd(), 'public', 'assets', 'apron', '05_backgrounds');

const S = {
  hangarBlueHour: 'ChatGPT Image Sep 15, 2026, 05_49_17 AM (6).png',
  apronSunrise: 'ChatGPT Image Sep 15, 2026, 05_49_17 AM (5).png',
  closeProtection: 'ChatGPT Image Sep 15, 2026, 05_49_17 AM (9).png',
  groundTransport: 'ChatGPT Image Sep 15, 2026, 05_49_17 AM (8).png',
};

/**
 * Landscape hero crops.
 *
 * `position: 'right'` keeps the aircraft in frame while letting the open sky fall to the
 * left, under the copy.
 */
const JOBS = [
  {
    out: 'login-auth',
    source: S.hangarBlueHour,
    width: 2000,
    height: 1125,
    position: sharp.strategy.attention,
    quality: 82,
    note: 'Blue-hour hangar. Dark values suit the navy panel; open sky sits under the wordmark.',
  },
  {
    out: 'client-hero',
    source: S.apronSunrise,
    width: 2000,
    height: 1125,
    position: 'right',
    quality: 82,
    note: 'Sunrise apron. Warmer and calmer — a client is being reassured, not shown a console.',
  },
  // Sidebars are portrait and render at ~0.14 opacity behind navigation, so the crop is
  // chosen for TONE rather than subject: what survives at that opacity is light and shape.
  {
    out: 'ops-sidebar',
    source: S.apronSunrise,
    width: 800,
    height: 1600,
    position: 'right',
    quality: 78,
    note: 'Apron at sunrise, cropped tall.',
  },
  {
    out: 'provider-sidebar',
    source: S.groundTransport,
    width: 800,
    height: 1600,
    position: 'left',
    quality: 78,
    // Cropped away from the vehicle and the figure: a recognisable person behind the
    // navigation reads as a subject rather than as atmosphere, even at 14% opacity.
    note: 'Aircraft and sunrise at the FBO — the dispatcher’s own world, without a subject.',
  },
  {
    out: 'admin-sidebar',
    source: S.hangarBlueHour,
    width: 800,
    height: 1600,
    position: 'left',
    quality: 78,
    note: 'The darkest, quietest crop. Admin is the most restrained portal (§21).',
  },
];

for (const job of JOBS) {
  const input = join(SOURCE, job.source);

  try {
    await access(input);
  } catch {
    console.error(`missing source: ${input}`);
    process.exit(1);
  }

  const buffer = await sharp(await readFile(input))
    .resize(job.width, job.height, { fit: 'cover', position: job.position })
    .webp({ quality: job.quality, effort: 6 })
    .toBuffer();

  await writeFile(join(OUT, `${job.out}.webp`), buffer);

  // The hand-drawn SVG that used to back this raster no longer describes it. Leaving a
  // stale cartoon vector beside a photograph would be its own small lie.
  await rm(join(OUT, `${job.out}.svg`), { force: true });

  console.log(`${job.out}.webp  ${String(Math.round(buffer.byteLength / 1024))} KB  — ${job.note}`);
}

console.log('\nphotography ingested');
