import { describe, expect, it } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  assignmentStrategies,
  fuelTypes,
  requestLineStatuses,
  requestPriorities,
  requestStatuses,
  resourceKinds,
  userRoles,
  vehicleClasses,
} from '@/db/schema/enums';
import {
  fuelTypeLabel,
  lineStatusLabel,
  priorityLabel,
  requestStatusLabel,
  resourceKindLabel,
  userRoleLabel,
  vehicleClassLabel,
  assignmentStrategyLabel,
  entityTypeLabel,
  permissionLabel,
  featureLabel,
  AUDIT_ACTION_LABELS,
} from '@/lib/domain-labels';
import { permissions, REASON_REQUIRED_ACTIONS } from '@/domain/permissions';

/**
 * No snake_case identifier reaches a user (CLAUDE.md §21).
 *
 * Two different guards, because they catch different mistakes:
 *
 *  1. **Every enum member has a readable label.** Catches a new member added to the schema
 *     with nobody updating the map — the label would silently fall back to a humanised key.
 *  2. **No page strips underscores by hand.** `value.replace(/_/g, ' ')` looks like a fix
 *     and is not: it turns `awaiting_confirmation` into "awaiting confirmation" (lowercase,
 *     no product voice) and `jet_a` into "jet a". Every such site should go through the
 *     label registry instead, so the wording is decided once.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

function sourceFiles(pattern: string): string[] {
  return globSync(pattern, { cwd: ROOT }).map((file) => file.split(sep).join('/'));
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('every enum a user can see has a readable label', () => {
  const cases: readonly [string, readonly string[], (value: string) => string][] = [
    ['user roles', userRoles, userRoleLabel],
    ['request statuses', requestStatuses, requestStatusLabel],
    ['service-line statuses', requestLineStatuses, lineStatusLabel],
    ['priorities', requestPriorities, priorityLabel],
    ['resource kinds', resourceKinds, resourceKindLabel],
    ['vehicle classes', vehicleClasses, vehicleClassLabel],
    ['fuel types', fuelTypes, fuelTypeLabel],
    ['assignment strategies', assignmentStrategies, assignmentStrategyLabel],
  ];

  for (const [name, values, label] of cases) {
    it(`${name}: no label contains an underscore`, () => {
      const offenders = values.filter((value) => label(value).includes('_'));
      expect(offenders, `these still read as identifiers: ${offenders.join(', ')}`).toEqual([]);
    });

    it(`${name}: no label is just the raw value`, () => {
      // A single lowercase word like "sedan" legitimately equals its label once capitalised,
      // so compare case-insensitively only for multi-word values.
      const offenders = values.filter((value) => value.includes('_') && label(value) === value);
      expect(offenders).toEqual([]);
    });

    it(`${name}: every label starts with a capital`, () => {
      const offenders = values.filter((value) => !/^[A-Z]/.test(label(value)));
      expect(offenders, `these read as lowercase fragments: ${offenders.join(', ')}`).toEqual([]);
    });
  }
});

describe('no page strips underscores by hand', () => {
  /**
   * `decision-trace.tsx` is the one allowed exception: it calls `describeReason` first and
   * only falls back to stripping underscores for a reason code from an ENGINE VERSION this
   * build no longer describes. That fallback is about forward compatibility, not laziness.
   */
  const ALLOWED = new Set(['src/components/requests/decision-trace.tsx']);

  it('finds the UI to check', () => {
    expect(sourceFiles('src/app/**/*.tsx').length).toBeGreaterThan(20);
  });

  it('routes enum wording through the label registry instead', () => {
    const offenders: string[] = [];

    for (const file of [...sourceFiles('src/app/**/*.tsx'), ...sourceFiles('src/components/**/*.tsx')]) {
      if (ALLOWED.has(file)) continue;
      if (/replace\(\/_\/g/.test(read(file))) offenders.push(file);
    }

    expect(
      offenders,
      `use a label from src/lib/domain-labels instead of stripping underscores in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * Values that live in DATA, not in a schema enum — permission keys, audit entity types,
 * and the capability tags a provider puts on a vehicle. The source guard above cannot see
 * these: nothing in the page says `replace(/_/g)`, the raw value simply arrives from the
 * database and is rendered. They were caught by fetching the running pages, so they are
 * pinned here.
 */
describe('values that arrive from data still read as English', () => {
  it('every permission has a phrase, not a key', () => {
    const offenders = permissions.filter(
      (key) => permissionLabel(key).includes('_') || permissionLabel(key).includes('.'),
    );
    expect(offenders, `these still read as keys: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every permission phrase is distinct', () => {
    // Two permissions reading the same would make the matrix lie about what a role holds.
    const labels = permissions.map(permissionLabel);
    expect(new Set(labels).size).toBe(permissions.length);
  });

  it('every audit entity type a write records has a name', () => {
    // Read from the source rather than a second list, so a new entity type fails here.
    const declared = [
      ...new Set(
        sourceFiles('src/**/*.ts')
          .flatMap((file) => [...read(file).matchAll(/entityType: '([a-z_]+)'/g)])
          .map((match) => match[1] as string),
      ),
    ];

    expect(declared.length).toBeGreaterThan(10);

    const offenders = declared.filter((type) => entityTypeLabel(type).includes('_'));
    expect(offenders, `these read as table names: ${offenders.join(', ')}`).toEqual([]);
  });

  it('capability tags on seeded vehicles read as equipment', () => {
    const tags = [
      ...new Set(
        [...read('src/db/seed/reference/network.ts').matchAll(/features: \[([^\]]*)\]/g)]
          .flatMap((match) => (match[1] as string).match(/'([a-z0-9_]+)'/g) ?? [])
          .map((quoted) => quoted.replaceAll("'", '')),
      ),
    ];

    expect(tags.length).toBeGreaterThan(4);
    expect(tags.filter((tag) => featureLabel(tag).includes('_'))).toEqual([]);
  });

  it('an unknown tag a provider invents is still readable, never raw', () => {
    // Free-form by design: a provider can add a tag this build has never seen.
    expect(featureLabel('bullet_resistant_glass')).toBe('Bullet resistant glass');
  });
});

/**
 * Audit actions are the sharpest version of this problem, because the label and the value
 * live in different files and nothing connects them. Several labels here were written
 * against a GUESSED key — `offer.acknowledged` where the service emits `offer.acknowledge`,
 * `auth.sign_in` where it emits `auth.login` — so those rows quietly fell back to a
 * humanised identifier ("Offer.acknowledge") while the map looked complete.
 *
 * This reads the action strings out of the real `recordAuditEvent` call sites, so a label
 * can never again be written for a key nothing emits.
 */
describe('every audit action a service emits has a label', () => {
  function emittedActions(): readonly string[] {
    const sources = [...sourceFiles('src/**/*.ts'), ...sourceFiles('src/**/*.tsx')];

    const actions = sources.flatMap((file) => {
      const text = read(file);
      return [...text.matchAll(/recordAuditEvent\(([\s\S]{0,600}?)\n\s*\);/g)].flatMap((call) =>
        [...(call[1] as string).matchAll(/action: '([a-z_.]+)'/g)].map((m) => m[1] as string),
      );
    });

    return [...new Set(actions)].sort();
  }

  it('finds the call sites', () => {
    expect(emittedActions().length).toBeGreaterThan(20);
  });

  it('no emitted action falls back to a humanised identifier', () => {
    const offenders = emittedActions().filter((action) => AUDIT_ACTION_LABELS[action] === undefined);

    expect(
      offenders,
      `these render as raw identifiers in the audit explorer: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every reason-required action is named in English too', () => {
    // These are the ones a governance reader is most likely to be looking for.
    const offenders = REASON_REQUIRED_ACTIONS.filter(
      (action) => AUDIT_ACTION_LABELS[action] === undefined,
    );
    expect(offenders).toEqual([]);
  });
});
