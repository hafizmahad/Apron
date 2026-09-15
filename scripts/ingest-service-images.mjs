import { readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Ingests the supplied service photography (CLAUDE.md §21).
 *
 * The asset registry and the six filenames already exist, so only the bytes are replaced —
 * no code references change, and `serviceImages` keeps its exact shape.
 *
 * Cropped to a consistent 16:10 so every service card is the same height and the grid
 * cannot go ragged. §21 requires service-card imagery to be "consistent in crop, radius,
 * aspect ratio and treatment"; the aspect ratio is settled here rather than left to CSS,
 * which is what stops a tall source image from quietly changing one card's proportions.
 *
 *   node scripts/ingest-service-images.mjs
 */

const SOURCE = 'C:/Users/hafiz/Downloads';
const OUT = join(process.cwd(), 'public', 'assets', 'apron', '06_service_images');

/** Rendered at roughly 380px wide on a three-column grid; 900px covers 2x displays. */
const WIDTH = 900;
const HEIGHT = 563;

const JOBS = [
  { out: 'ground-transport', source: 'Ground transport.png' },
  { out: 'close-protection', source: 'Close protection.png' },
  { out: 'hotel', source: 'Hotels.png' },
  { out: 'catering', source: 'Catering.png' },
  { out: 'fuel', source: 'Fueling.png' },
  { out: 'hangar', source: 'Hanger.png' },
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
    // `attention` keeps the subject rather than the geometric centre, which matters when
    // the aircraft or the vehicle sits off to one side of the frame.
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
    .webp({ quality: 80, effort: 6 })
    .toBuffer();

  await writeFile(join(OUT, `${job.out}.webp`), buffer);

  // The placeholder vector these replace no longer describes the file beside it.
  await rm(join(OUT, `${job.out}.svg`), { force: true });

  console.log(`${job.out}.webp  ${String(Math.round(buffer.byteLength / 1024))} KB`);
}

console.log('\nservice images ingested');
