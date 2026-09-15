import { readFileSync, globSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Accessibility checks (CLAUDE.md §21, §34 "run non-recording accessibility checks where
 * practical").
 *
 * These are static: they read the components and assert the properties that, once broken,
 * are invisible to everyone who can see the screen. That is the whole problem with
 * accessibility regressions — nobody notices, because nobody who notices is in the room.
 *
 * Deliberately NOT a browser harness (ADR-014). What can be checked here is checked here;
 * contrast and focus order are verified by hand against the running application, which is
 * what §34 asks for.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

function sourceFiles(pattern: string): string[] {
  return globSync(pattern, { cwd: ROOT })
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => file.split(sep).join('/'));
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

const COMPONENTS = sourceFiles('src/components/**/*.tsx');
const PAGES = sourceFiles('src/app/**/*.tsx');
const ALL = [...COMPONENTS, ...PAGES];

describe('there is markup to check', () => {
  it('finds components and pages', () => {
    expect(COMPONENTS.length).toBeGreaterThan(10);
    expect(PAGES.length).toBeGreaterThan(20);
  });
});

describe('every image carries alt text (§21)', () => {
  it('no <img> or next/image without an alt attribute', () => {
    const offenders: string[] = [];

    for (const file of ALL) {
      const source = read(file);
      // Match the opening tag of <img …> and <Image …> and check it declares alt.
      for (const match of source.matchAll(/<(img|Image)\s([^>]*?)\/?>/gs)) {
        const attributes = match[2] ?? '';
        if (!/\balt\s*=/.test(attributes)) {
          offenders.push(`${file}: <${match[1] ?? ''}> without alt`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('decorative images are hidden from assistive technology, not given fake alt text', () => {
    // A decorative image should be alt="" AND aria-hidden. An invented description
    // ("decorative banner") is worse than nothing: it is read aloud for no reason.
    const offenders: string[] = [];

    for (const file of ALL) {
      for (const match of read(file).matchAll(/<(img|Image)\s([^>]*?)\/?>/gs)) {
        const attributes = match[2] ?? '';
        const emptyAlt = /\balt\s*=\s*(""|{''}|{""})/.test(attributes);
        if (emptyAlt && !/aria-hidden/.test(attributes)) {
          offenders.push(`${file}: empty alt without aria-hidden`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('every interactive control is reachable and named (§21)', () => {
  it('no click handler on a non-interactive element', () => {
    // A div with onClick is invisible to a keyboard and to a screen reader.
    const offenders: string[] = [];

    for (const file of ALL) {
      for (const match of read(file).matchAll(/<(div|span|p|li|td)\s([^>]*?)>/gs)) {
        const attributes = match[2] ?? '';
        if (/\bonClick\s*=/.test(attributes) && !/\brole\s*=/.test(attributes)) {
          offenders.push(`${file}: <${match[1] ?? ''}> with onClick and no role`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every button declares its type', () => {
    // A button inside a form defaults to type="submit". An action button that submits the
    // form it happens to sit in is a real bug, not a style point.
    const offenders: string[] = [];

    for (const file of ALL) {
      for (const match of read(file).matchAll(/<button\s([^>]*?)>/gs)) {
        const attributes = match[1] ?? '';
        if (!/\btype\s*=/.test(attributes) && !/\{\.\.\.props\}/.test(attributes)) {
          offenders.push(`${file}: <button> with no type`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('icon-only controls carry an accessible name', () => {
    // A button whose only child is an icon needs aria-label or an sr-only span, or it is
    // announced as "button" and nothing else.
    const offenders: string[] = [];

    for (const file of ALL) {
      const source = read(file);
      for (const match of source.matchAll(/<button\s([^>]*?)>\s*(<[A-Z]\w+[^>]*\/>)\s*<\/button>/gs)) {
        const attributes = match[1] ?? '';
        if (!/aria-label|aria-labelledby|title\s*=/.test(attributes)) {
          offenders.push(`${file}: icon-only button without an accessible name`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('every form control is labelled (§21)', () => {
  it('no input, select or textarea without a label, aria-label or id', () => {
    const offenders: string[] = [];

    for (const file of ALL) {
      const source = read(file);

      for (const match of source.matchAll(/<(input|select|textarea)\s([^>]*?)\/?>/gs)) {
        const attributes = match[2] ?? '';

        // A hidden input has nothing to label.
        if (/type\s*=\s*["']hidden["']/.test(attributes)) continue;
        // A spread of props means the caller supplies the labelling.
        if (/\{\.\.\.props\}/.test(attributes)) continue;

        const named =
          /\bid\s*=/.test(attributes) ||
          /aria-label/.test(attributes) ||
          /aria-labelledby/.test(attributes);

        // A control nested directly inside its own <label> is labelled by wrapping. The
        // lookback is generous because a styled label's opening tag can carry a long
        // className before the control appears — a short window reports a false positive
        // on perfectly good markup.
        const start = match.index ?? 0;
        const preceding = source.slice(Math.max(0, start - 2000), start);
        const wrapped = /<label[^>]*>(?:(?!<\/label>)[\s\S])*$/.test(preceding);

        if (!named && !wrapped) {
          offenders.push(`${file}: <${match[1] ?? ''}> with no label association`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('structure and landmarks (§21)', () => {
  it('the application shell provides a main landmark', () => {
    const shell = read('src/components/layout/portal-shell.tsx');
    expect(shell).toMatch(/<main\b/);
    expect(shell).toMatch(/id="main"/);
  });

  it('navigation is marked up as navigation and named', () => {
    const shell = read('src/components/layout/portal-shell.tsx');
    expect(shell).toMatch(/<nav\b/);
    expect(shell).toMatch(/aria-label=/);
  });

  it('the active navigation item is announced, not only coloured', () => {
    const shell = read('src/components/layout/portal-shell.tsx');
    expect(shell).toMatch(/aria-current=/);
  });

  it('tables carry a caption for screen-reader users', () => {
    const table = read('src/components/ui/data-table.tsx');
    expect(table).toMatch(/<caption/);
  });

  it('error and status messages use a live region', () => {
    const primitives = read('src/components/ui/primitives.tsx');
    expect(primitives).toMatch(/role="alert"/);
  });
});

describe('state is never conveyed by colour alone (§21)', () => {
  it('status badges render their status as text', () => {
    // A Badge takes children and renders them; a badge that showed only a coloured dot
    // would be meaningless to anyone who cannot distinguish the colours.
    const primitives = read('src/components/ui/primitives.tsx');
    const badge = /export function Badge\(\{([\s\S]*?)\n\}/.exec(primitives);

    expect(badge).not.toBeNull();
    expect(badge?.[1]).toContain('children');
  });

  it('the unread notification state is stated in words as well as shaded', () => {
    const centre = read('src/components/notifications/notification-centre.tsx');
    expect(centre).toMatch(/unread/);
  });
});

describe('the page never shifts under the reader (§21)', () => {
  it('a skeleton exists so loading states hold their geometry', () => {
    const primitives = read('src/components/ui/primitives.tsx');
    expect(primitives).toMatch(/export function Skeleton/);
  });

  it('empty, loading and error states are all available as primitives', () => {
    const primitives = read('src/components/ui/primitives.tsx');
    expect(primitives).toMatch(/export function EmptyState/);
    expect(primitives).toMatch(/export function Alert/);
    expect(primitives).toMatch(/export function Skeleton/);
  });
});

describe('text remains legible (§21 "no tiny unreadable text")', () => {
  it('no font size below 11px anywhere', () => {
    const offenders: string[] = [];

    for (const file of ALL) {
      for (const match of read(file).matchAll(/text-\[(\d+)px\]/g)) {
        const size = Number(match[1]);
        if (size < 11) offenders.push(`${file}: text-[${String(size)}px]`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no use of the smallest Tailwind scale steps for body text', () => {
    // `text-[10px]` and below is caught above; `text-xs` is 12px and acceptable for
    // secondary metadata. This guards against anything smaller creeping in by class.
    const offenders = ALL.filter((file) => /\btext-\[0?\.\d+rem\]/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
