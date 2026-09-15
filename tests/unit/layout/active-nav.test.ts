import { describe, expect, it } from 'vitest';
import { activeNavHref } from '@/components/layout/portal-shell';
import type { NavSection } from '@/components/layout/portal-shell';

/**
 * Sidebar active-item resolution.
 *
 * This exists because the original rule — "active if the path starts with the href" —
 * marked the portal root current on every page beneath it. On `/admin/requests` both
 * *Overview* and *Request oversight* were highlighted, so a reader could not tell where
 * they were, and `aria-current="page"` was announced twice.
 *
 * Nothing caught it: the routing verifier checked that links resolved, the accessibility
 * suite checked that `aria-current` was used at all, and neither checked that exactly one
 * item carries it. That is what these assertions are for.
 */

/** The real admin navigation, shaped as the layout builds it. */
const ADMIN: readonly NavSection[] = [
  { items: [{ href: '/admin', label: 'Overview', icon: null }] },
  {
    title: 'Governance',
    items: [
      { href: '/admin/providers', label: 'Provider approvals', icon: null },
      { href: '/admin/users', label: 'Users & roles', icon: null },
      { href: '/admin/requests', label: 'Request oversight', icon: null },
      { href: '/admin/audit', label: 'Audit explorer', icon: null },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { href: '/admin/catalogue', label: 'Service catalogue', icon: null },
      { href: '/admin/registry', label: 'Airport & FBO registry', icon: null },
      { href: '/admin/settings', label: 'Settings & flags', icon: null },
    ],
  },
  {
    title: 'Observability',
    items: [
      { href: '/admin/ai', label: 'AI reliability', icon: null },
      { href: '/admin/notifications', label: 'Notifications', icon: null },
    ],
  },
];

const OPS: readonly NavSection[] = [
  {
    items: [
      { href: '/ops', label: 'Dashboard', icon: null },
      { href: '/ops/requests', label: 'Requests', icon: null },
      { href: '/ops/schedule', label: 'Schedule', icon: null },
      { href: '/ops/exceptions', label: 'Exceptions', icon: null },
    ],
  },
  {
    title: 'Network',
    items: [
      { href: '/ops/providers', label: 'Providers', icon: null },
      { href: '/ops/airports', label: 'Airports & FBOs', icon: null },
    ],
  },
  {
    title: 'Tools',
    items: [
      { href: '/ops/research', label: 'Research assistant', icon: null },
      { href: '/ops/messages', label: 'Messages', icon: null },
      { href: '/ops/notifications', label: 'Notifications', icon: null },
    ],
  },
];

const PROVIDER: readonly NavSection[] = [
  {
    items: [
      { href: '/provider', label: 'Dashboard', icon: null },
      { href: '/provider/queue', label: 'Request queue', icon: null },
      { href: '/provider/schedule', label: 'Schedule', icon: null },
    ],
  },
  {
    title: 'Company',
    items: [
      { href: '/provider/resources', label: 'Resources', icon: null },
      { href: '/provider/coverage', label: 'Coverage & hours', icon: null },
      { href: '/provider/team', label: 'Team', icon: null },
      { href: '/provider/messages', label: 'Messages', icon: null },
      { href: '/provider/notifications', label: 'Notifications', icon: null },
    ],
  },
];

const ALL_PORTALS: readonly { name: string; root: string; sections: readonly NavSection[] }[] = [
  { name: 'admin', root: '/admin', sections: ADMIN },
  { name: 'ops', root: '/ops', sections: OPS },
  { name: 'provider', root: '/provider', sections: PROVIDER },
];

function allHrefs(sections: readonly NavSection[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.href));
}

describe('exactly one navigation item is ever current', () => {
  for (const portal of ALL_PORTALS) {
    it(`${portal.name}: the root is current only on the root itself`, () => {
      expect(activeNavHref(portal.root, portal.sections)).toBe(portal.root);

      for (const href of allHrefs(portal.sections)) {
        if (href === portal.root) continue;
        // This is the exact bug: on a sub-page, the root must NOT win.
        expect(activeNavHref(href, portal.sections), href).not.toBe(portal.root);
      }
    });

    it(`${portal.name}: every nav destination selects itself`, () => {
      for (const href of allHrefs(portal.sections)) {
        expect(activeNavHref(href, portal.sections), href).toBe(href);
      }
    });

    it(`${portal.name}: a nested route selects its own section, not the root`, () => {
      for (const href of allHrefs(portal.sections)) {
        if (href === portal.root) continue;
        const nested = `${href}/8f2c1d94-0000-4000-8000-000000000000`;
        expect(activeNavHref(nested, portal.sections), nested).toBe(href);
      }
    });
  }
});

describe('the resolver picks the most specific match', () => {
  it('prefers a longer href over a shorter one that also matches', () => {
    // `/ops/requests/abc` matches both `/ops` and `/ops/requests`. The longer wins.
    expect(activeNavHref('/ops/requests/abc', OPS)).toBe('/ops/requests');
  });

  it('returns null for a path outside the navigation', () => {
    expect(activeNavHref('/somewhere-else', ADMIN)).toBeNull();
  });

  it('does not match on a shared prefix that is not a path boundary', () => {
    const sections: readonly NavSection[] = [
      { items: [{ href: '/ops/request', label: 'Singular', icon: null }] },
    ];
    // `/ops/requests` must not be treated as nested under `/ops/request`.
    expect(activeNavHref('/ops/requests', sections)).toBeNull();
  });

  it('is unaffected by the order items are declared in', () => {
    const reversed: readonly NavSection[] = [...ADMIN].reverse();
    expect(activeNavHref('/admin/requests', reversed)).toBe('/admin/requests');
    expect(activeNavHref('/admin', reversed)).toBe('/admin');
  });
});
