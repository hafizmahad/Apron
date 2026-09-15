import Image from 'next/image';
import { Card, CardHeader } from '@/components/ui/primitives';
import { AviationIcon } from '@/components/ui/domain-icon';
import { miscAssets } from '@/lib/assets';
import { getEnv } from '@/lib/config/env';

/**
 * The operational map (CLAUDE.md §17, ADR-011).
 *
 * The provider is abstracted behind configuration. The default `static` adapter projects
 * REAL stored coordinates onto the packaged abstract world map — no key, no network, no
 * third-party request from a page showing client movements.
 *
 * Two rules it does not bend:
 *
 *  1. **No fabricated coordinates.** A marker is rendered only for a point the database
 *     actually holds. FBO positions are deliberately not stored, so an FBO is named in the
 *     caption rather than pinned at a guessed spot on the field.
 *  2. **Useful, not decorative.** If there is nothing real to show, the card says what it
 *     knows in words instead of drawing an empty map.
 */

interface PlottedPoint {
  readonly label: string;
  readonly sublabel?: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly kind: 'airport' | 'destination';
}

export interface MapPoint {
  readonly label: string;
  readonly sublabel?: string;
  /** Decimal degrees as stored — strings, because the column is numeric. */
  readonly latitude: string;
  readonly longitude: string;
  readonly kind: 'airport' | 'destination';
}

export function MapCard({
  points,
  caption,
}: {
  readonly points: readonly MapPoint[];
  readonly caption?: string;
}) {
  const env = getEnv();

  // Only points the database actually holds are plotted; an unparseable value is dropped
  // rather than defaulted to 0,0 — which would place a marker in the Atlantic.
  const plotted: PlottedPoint[] = [];
  for (const point of points) {
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    plotted.push({
      label: point.label,
      ...(point.sublabel === undefined ? {} : { sublabel: point.sublabel }),
      latitude,
      longitude,
      kind: point.kind,
    });
  }

  if (plotted.length === 0) {
    return (
      <Card>
        <CardHeader title="Map" description="No stored coordinates for this request." />
        <p className="px-5 py-4 text-[13px] leading-relaxed text-text-secondary">
          Nothing is plotted because the platform holds no coordinates for these locations.
          A guessed position would be worse than none.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Map"
        description={
          env.NEXT_PUBLIC_MAP_PROVIDER === 'static'
            ? 'Stored coordinates projected onto a schematic world map.'
            : 'Live map tiles.'
        }
      />

      <div className="relative">
        {/* Equirectangular projection: x = (lon + 180) / 360, y = (90 - lat) / 180. */}
        <div className="relative aspect-[2/1] w-full overflow-hidden bg-canvas-cool">
          <Image
            src={miscAssets.worldMap}
            alt=""
            aria-hidden
            fill
            sizes="(max-width: 1024px) 100vw, 640px"
            className="object-cover opacity-70"
          />

          {plotted.map((point) => {
            const left = ((point.longitude + 180) / 360) * 100;
            const top = ((90 - point.latitude) / 180) * 100;

            return (
              <div
                key={`${point.label}-${point.latitude}-${point.longitude}`}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${left}%`, top: `${top}%` }}
              >
                <span className="relative flex size-3">
                  <span
                    className={
                      point.kind === 'airport'
                        ? 'absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-40'
                        : 'hidden'
                    }
                  />
                  <span
                    className={
                      point.kind === 'airport'
                        ? 'relative inline-flex size-3 rounded-full bg-accent ring-2 ring-surface'
                        : 'relative inline-flex size-3 rounded-full bg-info ring-2 ring-surface'
                    }
                  />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <ul className="divide-y divide-border">
        {plotted.map((point) => (
          <li
            key={`${point.label}-legend`}
            className="flex items-start gap-3 px-5 py-3"
          >
            <AviationIcon
              name={point.kind === 'airport' ? 'airport' : 'arrival'}
              label=""
              className="mt-0.5 size-4 text-accent"
            />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-text-primary">{point.label}</p>
              {point.sublabel !== undefined && (
                <p className="mt-0.5 text-[12px] text-text-secondary">{point.sublabel}</p>
              )}
              <p className="tabular mt-0.5 text-[11px] text-text-secondary">
                {point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {caption !== undefined && (
        <p className="border-t border-border px-5 py-2.5 text-[12px] leading-relaxed text-text-secondary">
          {caption}
        </p>
      )}
    </Card>
  );
}
