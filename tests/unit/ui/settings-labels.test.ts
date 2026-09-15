import { describe, expect, it } from 'vitest';
import {
  FLAG_LABELS,
  SETTING_LABELS,
  flagLabel,
  groupByArea,
  settingLabel,
} from '@/lib/settings-labels';
import { seedPlatformSettings, seedFeatureFlags } from '@/db/seed/reference/catalogue';

/**
 * Every setting and flag a user can see has a human-readable name (CLAUDE.md §21).
 *
 * The labels are presentation only — the key remains the identity everywhere else — so the
 * risk this guards against is drift: somebody adds `matching.new_knob`, nobody adds a
 * label, and an administrator is shown a raw dotted key in an otherwise finished console.
 *
 * The seeds are the source of truth for "what exists", so this compares against them
 * rather than against a second hand-written list that could itself go stale.
 */

describe('every seeded setting has a readable name', () => {
  it('finds the seeds', () => {
    expect(seedPlatformSettings.length).toBeGreaterThan(0);
    expect(seedFeatureFlags.length).toBeGreaterThan(0);
  });

  it('labels every platform setting', () => {
    const missing = seedPlatformSettings
      .map((seed) => seed.key)
      .filter((key) => SETTING_LABELS[key] === undefined);

    expect(missing, `add these to SETTING_LABELS: ${missing.join(', ')}`).toEqual([]);
  });

  it('labels every feature flag', () => {
    const missing = seedFeatureFlags
      .map((seed) => seed.key)
      .filter((key) => FLAG_LABELS[key] === undefined);

    expect(missing, `add these to FLAG_LABELS: ${missing.join(', ')}`).toEqual([]);
  });

  it('never shows a label that is just the key back again', () => {
    for (const [key, entry] of Object.entries(SETTING_LABELS)) {
      expect(entry.label, key).not.toBe(key);
      expect(entry.label, key).not.toMatch(/[._]/);
    }
    for (const [key, entry] of Object.entries(FLAG_LABELS)) {
      expect(entry.label, key).not.toBe(key);
      expect(entry.label, key).not.toMatch(/[._]/);
    }
  });

  it('gives a numeric setting a unit, so a bare number is never ambiguous', () => {
    // "Acknowledgement window: 45" means nothing without "minutes".
    for (const [key, entry] of Object.entries(SETTING_LABELS)) {
      if (/minutes|hours|attempts|bonus/.test(key)) {
        expect(entry.unit, `${key} needs a unit`).toBeDefined();
      }
    }
  });
});

describe('the fallback is a safety net, not the normal path', () => {
  it('humanises an unknown key rather than rendering nothing', () => {
    const fallback = settingLabel('matching.some_future_knob');
    expect(fallback.label).toBe('Matching some future knob');
    expect(fallback.label).not.toBe('');
  });

  it('does the same for an unknown flag', () => {
    expect(flagLabel('ai.something_new').label).toBe('Ai something new');
  });
});

describe('grouping', () => {
  const rows = [
    { key: 'sla.acknowledgement_minutes.default' },
    { key: 'matching.max_rematch_attempts' },
    { key: 'matching.same_provider_bonus' },
    { key: 'requests.guest_link_ttl_hours' },
  ];

  it('puts matching and the SLA first — what an administrator reaches for in a hurry', () => {
    const grouped = groupByArea(rows, (row) => row.key, settingLabel);
    expect(grouped[0]?.group).toBe('Matching');
    expect(grouped[1]?.group).toBe('Acknowledgement SLA');
  });

  it('keeps every row, losing none to grouping', () => {
    const grouped = groupByArea(rows, (row) => row.key, settingLabel);
    const total = grouped.reduce((sum, section) => sum + section.rows.length, 0);
    expect(total).toBe(rows.length);
  });

  it('orders within a group by label, so the page does not reshuffle', () => {
    const grouped = groupByArea(rows, (row) => row.key, settingLabel);
    const matching = grouped.find((section) => section.group === 'Matching');

    expect(matching?.rows.map((row) => settingLabel(row.key).label)).toEqual([
      'Maximum rematch attempts',
      'Same-provider consolidation bonus',
    ]);
  });
});
