import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cn } from '@/lib/cn';
import {
  aviationIcons,
  brandAssets,
  domainIcons,
  serviceIconFor,
  type AviationIconKey,
  type DomainIconKey,
} from '@/lib/assets';

/**
 * Renders a pack SVG inline so `currentColor` resolves against the surrounding design
 * token (CLAUDE.md §21 asset rules). An `<img>` would flatten the glyph to whatever
 * colour the file happens to contain, which is exactly what the pack's `currentColor`
 * authoring is designed to avoid.
 *
 * The SVG text is read from `public/` at render time on the server and memoised per
 * process. These files are 250–500 bytes each and there are ~26 of them, so the whole
 * set costs a few kilobytes of resident memory and no network request.
 *
 * Generic interface icons (search, bell, filter, chevrons …) come from `lucide-react`;
 * this component is only for aviation, service and operations concepts.
 */

const cache = new Map<string, string>();

function loadSvg(publicPath: string): string | null {
  const cached = cache.get(publicPath);
  if (cached !== undefined) return cached;

  try {
    const absolute = join(process.cwd(), 'public', publicPath.replace(/^\//, ''));
    const raw = readFileSync(absolute, 'utf8');
    const body = extractSvgBody(raw);
    cache.set(publicPath, body);
    return body;
  } catch (error) {
    // A missing asset must degrade to a blank box, never a broken-image glyph
    // (CLAUDE.md §21 "implement graceful fallback if an image is missing").
    console.warn(`[apron] icon asset unavailable: ${publicPath}`, error);
    return null;
  }
}

/** Strips the outer <svg> wrapper and any XML/comment preamble, keeping the drawing. */
function extractSvgBody(raw: string): string {
  const openTagEnd = raw.indexOf('>', raw.indexOf('<svg'));
  const closeTagStart = raw.lastIndexOf('</svg>');
  if (openTagEnd === -1 || closeTagStart === -1) return '';
  return raw.slice(openTagEnd + 1, closeTagStart).trim();
}

/** Reads the viewBox so inlined glyphs keep the pack's intended geometry. */
function extractViewBox(publicPath: string): string {
  try {
    const absolute = join(process.cwd(), 'public', publicPath.replace(/^\//, ''));
    const raw = readFileSync(absolute, 'utf8');
    const match = /viewBox="([^"]+)"/.exec(raw);
    return match?.[1] ?? '0 0 24 24';
  } catch {
    return '0 0 24 24';
  }
}

interface InlineSvgProps {
  readonly path: string;
  readonly title: string;
  readonly className?: string;
  /** Pack line icons are stroked, brand/illustration glyphs are filled. */
  readonly stroked?: boolean;
}

function InlineSvg({ path, title, className, stroked = true }: InlineSvgProps) {
  const body = loadSvg(path);
  if (body === null) {
    return <span aria-hidden className={cn('inline-block size-[1em]', className)} />;
  }

  const strokeProps = stroked
    ? {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.65,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
      }
    : {};

  return (
    <svg
      viewBox={extractViewBox(path)}
      role="img"
      aria-label={title}
      className={cn('size-5 shrink-0', className)}
      {...strokeProps}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

export function ServiceIcon({
  code,
  label,
  className,
}: {
  readonly code: string;
  readonly label: string;
  readonly className?: string;
}) {
  return <InlineSvg path={serviceIconFor(code)} title={label} {...(className === undefined ? {} : { className })} />;
}

export function AviationIcon({
  name,
  label,
  className,
}: {
  readonly name: AviationIconKey;
  readonly label: string;
  readonly className?: string;
}) {
  return <InlineSvg path={aviationIcons[name]} title={label} {...(className === undefined ? {} : { className })} />;
}

export function DomainIcon({
  name,
  label,
  className,
}: {
  readonly name: DomainIconKey;
  readonly label: string;
  readonly className?: string;
}) {
  return <InlineSvg path={domainIcons[name]} title={label} {...(className === undefined ? {} : { className })} />;
}

/**
 * The Apron mark, inlined so the feather inherits `currentColor` and reads correctly on
 * both the navy sidebar and light surfaces (see `brandAssets.markAdaptive`).
 */
export function ApronMark({ className }: { readonly className?: string }) {
  return (
    <InlineSvg
      path={brandAssets.markAdaptive}
      title="Apron"
      stroked={false}
      className={cn('h-6 w-8', className)}
    />
  );
}
