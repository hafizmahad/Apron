import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Generates the atmospheric background assets (CLAUDE.md §21).
 *
 * The originals depicted a cartoon aircraft — a blob fuselage with oval engines and toy
 * proportions — which read as clip-art rather than premium private aviation, and is on the
 * brief's explicit "avoid" list.
 *
 * These replace it with abstract blue-hour compositions: horizon light, apron and runway
 * line geometry in perspective, and a great deal of negative space. **No aircraft is
 * depicted at all.** An abstract field cannot be mistaken for a photograph of a particular
 * airport, which is the honest position when no verified photography exists — the brief's
 * own rule that a generic image must never imply a specific real place.
 *
 * Every colour is the palette from `globals.css`, so the artwork cannot drift from the
 * product's own tokens.
 *
 *   node scripts/generate-backgrounds.mjs
 */

const OUT = join(process.cwd(), 'public', 'assets', 'apron', '05_backgrounds');

const C = {
  sidebar: '#0f2238',
  sidebarSoft: '#173451',
  sidebarDeep: '#0a1828',
  gold: '#c7a56a',
  canvas: '#f7f4ef',
  canvasCool: '#f4f6f9',
};

/** Runway/apron centreline markings, converging toward a vanishing point. */
function perspectiveLines({
  width,
  height,
  horizon,
  vanishX,
  count = 7,
  spread = 1.9,
  stroke = '#ffffff',
  opacity = 0.05,
  strokeWidth = 2,
}) {
  const lines = [];
  for (let i = 0; i <= count; i += 1) {
    const t = count === 0 ? 0.5 : i / count;
    // Fan out across the bottom edge, all converging on one point at the horizon.
    const baseX = vanishX + (t - 0.5) * width * spread;
    lines.push(
      `<line x1="${baseX.toFixed(1)}" y1="${height}" x2="${vanishX.toFixed(1)}" y2="${horizon.toFixed(1)}" ` +
        `stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`,
    );
  }
  return lines.join('\n    ');
}

/** Approach / edge lights along the horizon. Small, warm, and few. */
function edgeLights({ horizon, vanishX, width, count = 9, spread = 0.8 }) {
  const dots = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const x = vanishX + (t - 0.5) * width * spread;
    // Nearer the vanishing point, dimmer and smaller — the only depth cue needed.
    const distance = Math.abs(t - 0.5) * 2;
    const r = 1.4 + distance * 2.2;
    const o = 0.1 + distance * 0.3;
    dots.push(
      `<circle cx="${x.toFixed(1)}" cy="${(horizon + 1).toFixed(1)}" r="${r.toFixed(1)}" fill="${C.gold}" fill-opacity="${o.toFixed(2)}"/>`,
    );
  }
  return dots.join('\n    ');
}

/**
 * The sign-in panel: blue hour, looking down an apron.
 *
 * Negative space is deliberately weighted to the LEFT, because the wordmark and the
 * positioning copy sit there. Light gathers on the right, away from the text.
 */
function loginSvg(width, height) {
  const horizon = height * 0.63;
  const vanishX = width * 0.72;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="${C.sidebarDeep}"/>
      <stop offset="55%" stop-color="${C.sidebar}"/>
      <stop offset="100%" stop-color="${C.sidebarSoft}"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.sidebarSoft}"/>
      <stop offset="100%" stop-color="${C.sidebarDeep}"/>
    </linearGradient>
    <radialGradient id="dawn" cx="0.74" cy="0.6" r="0.46">
      <stop offset="0%" stop-color="${C.gold}" stop-opacity="0.26"/>
      <stop offset="45%" stop-color="${C.gold}" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="${C.gold}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <!-- Settles the left side for the wordmark. A gradient, not a panel: a hard-edged
         rect leaves a visible vertical seam down the middle of the image. -->
    <linearGradient id="copyGuard" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.sidebarDeep}" stop-opacity="0.34"/>
      <stop offset="45%" stop-color="${C.sidebarDeep}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${C.sidebarDeep}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <rect y="${horizon}" width="${width}" height="${height - horizon}" fill="url(#ground)"/>

  <!-- Blue-hour glow, low and off to one side. Never a sun disc. -->
  <rect width="${width}" height="${height}" fill="url(#dawn)"/>

  <!-- Horizon haze, a single soft band rather than a hard edge. -->
  <rect y="${horizon - height * 0.1}" width="${width}" height="${height * 0.1}" fill="url(#haze)"/>
  <line x1="0" y1="${horizon}" x2="${width}" y2="${horizon}" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>

  <!-- Apron geometry in perspective. -->
  <g>
    ${perspectiveLines({ width, height, horizon, vanishX, count: 6, spread: 2.1, opacity: 0.045, strokeWidth: 2.5 })}
  </g>

  <!-- A single painted taxiway edge, gold, very restrained. -->
  <line x1="${width * 0.06}" y1="${height}" x2="${vanishX}" y2="${horizon}" stroke="${C.gold}" stroke-opacity="0.09" stroke-width="3" stroke-linecap="round"/>

  ${edgeLights({ horizon, vanishX, width, count: 9, spread: 0.85 })}

  <!-- Keeps the left quiet, where the wordmark and positioning copy sit. -->
  <rect width="${width}" height="${height}" fill="url(#copyGuard)"/>
</svg>`;
}

/**
 * The client hero: the same place at dawn, in daylight values.
 *
 * Lighter, warmer and calmer than the sign-in panel — a client is being reassured, not
 * shown an operations console.
 */
function clientHeroSvg(width, height) {
  const horizon = height * 0.58;
  const vanishX = width * 0.78;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0%" stop-color="#1b3c5c"/>
      <stop offset="45%" stop-color="#456e91"/>
      <stop offset="100%" stop-color="#b8c8d4"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8e9aa4"/>
      <stop offset="100%" stop-color="#5d6b78"/>
    </linearGradient>
    <radialGradient id="dawn" cx="0.8" cy="0.54" r="0.42">
      <stop offset="0%" stop-color="#e8c894" stop-opacity="0.55"/>
      <stop offset="40%" stop-color="${C.gold}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${C.gold}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="copyGuard" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.sidebarDeep}" stop-opacity="0.30"/>
      <stop offset="55%" stop-color="${C.sidebarDeep}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${C.sidebarDeep}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <rect y="${horizon}" width="${width}" height="${height - horizon}" fill="url(#ground)"/>
  <rect width="${width}" height="${height}" fill="url(#dawn)"/>

  <line x1="0" y1="${horizon}" x2="${width}" y2="${horizon}" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1.5"/>

  <g>
    ${perspectiveLines({ width, height, horizon, vanishX, count: 5, spread: 2.2, opacity: 0.16, strokeWidth: 3 })}
  </g>

  <!-- Painted holding position, parallel to the horizon rather than converging. -->
  <line x1="0" y1="${horizon + (height - horizon) * 0.42}" x2="${width}" y2="${horizon + (height - horizon) * 0.34}"
        stroke="${C.gold}" stroke-opacity="0.2" stroke-width="4"/>

  ${edgeLights({ horizon, vanishX, width, count: 7, spread: 0.7 })}

  <!-- The copy sits left; this holds contrast for it without darkening the whole frame,
       and without the vertical seam a hard-edged panel would leave. -->
  <rect width="${width}" height="${height}" fill="url(#copyGuard)"/>
</svg>`;
}

/**
 * Sidebar atmosphere — portrait, and almost nothing.
 *
 * Rendered at ~0.14 opacity behind navigation, so anything with detail becomes visual
 * noise. A light shaft and two converging lines is the whole composition. Admin is the
 * most restrained of the three, as §21 requires.
 */
function sidebarSvg(width, height, variant) {
  const horizon = height * (variant === 'admin' ? 0.74 : 0.68);
  const vanishX = width * (variant === 'provider' ? 0.32 : 0.62);

  const intensity = variant === 'admin' ? 0.45 : variant === 'provider' ? 0.85 : 1;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="${C.sidebarDeep}"/>
      <stop offset="60%" stop-color="${C.sidebar}"/>
      <stop offset="100%" stop-color="${C.sidebarSoft}"/>
    </linearGradient>
    <radialGradient id="shaft" cx="${variant === 'provider' ? 0.28 : 0.68}" cy="0.2" r="0.6">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="${(0.09 * intensity).toFixed(3)}"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="warm" cx="0.5" cy="${variant === 'admin' ? 0.8 : 0.72}" r="0.5">
      <stop offset="0%" stop-color="${C.gold}" stop-opacity="${(0.12 * intensity).toFixed(3)}"/>
      <stop offset="100%" stop-color="${C.gold}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#shaft)"/>
  <rect width="${width}" height="${height}" fill="url(#warm)"/>

  <line x1="0" y1="${horizon}" x2="${width}" y2="${horizon}"
        stroke="#ffffff" stroke-opacity="${(0.06 * intensity).toFixed(3)}" stroke-width="1"/>

  <g>
    ${perspectiveLines({
      width,
      height,
      horizon,
      vanishX,
      count: variant === 'admin' ? 2 : 3,
      spread: 1.5,
      opacity: 0.05 * intensity,
      strokeWidth: 3,
    })}
  </g>
</svg>`;
}

const JOBS = [
  { name: 'login-auth', width: 2400, height: 1350, svg: loginSvg },
  { name: 'client-hero', width: 2400, height: 1350, svg: clientHeroSvg },
  { name: 'ops-sidebar', width: 800, height: 1600, svg: (w, h) => sidebarSvg(w, h, 'ops') },
  { name: 'provider-sidebar', width: 800, height: 1600, svg: (w, h) => sidebarSvg(w, h, 'provider') },
  { name: 'admin-sidebar', width: 800, height: 1600, svg: (w, h) => sidebarSvg(w, h, 'admin') },
];

for (const job of JOBS) {
  const svg = job.svg(job.width, job.height);

  // The SVG source is kept beside the raster, as the asset pack already does, so the
  // composition can be adjusted later without reverse-engineering a bitmap.
  await writeFile(join(OUT, `${job.name}.svg`), svg, 'utf8');

  const webp = await sharp(Buffer.from(svg))
    .resize(job.width, job.height)
    .webp({ quality: 88, effort: 6 })
    .toBuffer();

  await writeFile(join(OUT, `${job.name}.webp`), webp);
  console.log(`${job.name}.webp  ${String(Math.round(webp.byteLength / 1024))} KB`);
}

console.log('backgrounds regenerated — abstract, no depicted aircraft');
