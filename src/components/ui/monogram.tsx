import { cn } from '@/lib/cn';

/**
 * A monogram derived from a real name (CLAUDE.md §21).
 *
 * This replaces three static avatar images that carried **hard-coded initials** — "JD",
 * "SP", "OP" — chosen by hashing the user id. Every signed-in person was therefore shown
 * somebody else's initials: "Sofia Lindqvist" appeared as "SP". A detail that small still
 * tells a reader the product is not really looking at their data.
 *
 * Derived, not stored: there is nothing to keep in sync and no image to fetch.
 *
 * The same component is the provider logo fallback. A real uploaded logo is used when one
 * exists; otherwise a company gets a clean monogram rather than an invented luxury-brand
 * mark, which would be a fabricated identity for a real business.
 */

/**
 * First letter of the first and last words.
 *
 * "Meridian Ground Services" gives MS, not MG — the last word is what distinguishes it
 * from "Meridian Ground Handling". Falls back to the first two letters of a single word,
 * and to a dash when there is nothing legible at all, because a blank circle looks broken
 * while a dash looks deliberate.
 */
export function initialsFrom(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word));

  if (words.length === 0) return '–';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();

  const first = words[0] ?? '';
  const last = words[words.length - 1] ?? '';
  return `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

/** Stable tone per subject, so the same person keeps the same colour between sessions. */
const TONES = ['navy', 'blue', 'gold'] as const;
type Tone = (typeof TONES)[number];

const TONE_CLASS: Record<Tone, string> = {
  navy: 'bg-sidebar text-text-inverse',
  blue: 'bg-sidebar-soft text-text-inverse',
  gold: 'bg-gold/85 text-sidebar-deep',
};

function toneFor(key: string): Tone {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 33 + key.charCodeAt(index)) >>> 0;
  }
  return TONES[hash % TONES.length] ?? 'navy';
}

const SIZE_CLASS = {
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-[13px]',
  lg: 'size-12 text-[16px]',
} as const;

export function Monogram({
  name,
  subjectId,
  size = 'md',
  className,
}: {
  readonly name: string;
  /** Keeps the colour stable for one subject. Defaults to the name. */
  readonly subjectId?: string;
  readonly size?: keyof typeof SIZE_CLASS;
  readonly className?: string;
}) {
  const initials = initialsFrom(name);

  return (
    <span
      // Decorative: the name it stands for is always rendered beside it, so announcing
      // the initials as well would just repeat the same information.
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-[0.02em]',
        SIZE_CLASS[size],
        TONE_CLASS[toneFor(subjectId ?? name)],
        className,
      )}
    >
      {initials}
    </span>
  );
}
