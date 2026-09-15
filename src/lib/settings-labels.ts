/**
 * Human-readable names for platform settings and feature flags (CLAUDE.md §21).
 *
 * Presentation only. The **key is the identity** — it is what the code reads, what the
 * audit trail records and what the API uses — and none of that changes here. This maps a
 * key to the words an administrator would use, so the console reads as a product rather
 * than as a configuration file.
 *
 * The raw key is still shown, small and secondary, because an administrator reading an
 * audit event or a support thread needs to connect the two.
 *
 * An unmapped key falls back to a readable form of the key itself rather than to nothing,
 * so adding a setting can never produce a blank row — and `tests/unit/ui/settings-labels`
 * fails if a seeded key has no entry, so the fallback stays a safety net rather than the
 * normal path.
 */

export interface SettingLabel {
  readonly label: string;
  /** Which part of the product this governs. Drives the grouping in the console. */
  readonly group: 'Matching' | 'Acknowledgement SLA' | 'Requests' | 'AI' | 'Client access' | 'Notifications';
  /** The unit, where a bare number would be ambiguous. */
  readonly unit?: string;
}

export const SETTING_LABELS: Readonly<Record<string, SettingLabel>> = {
  'matching.max_rematch_attempts': {
    label: 'Maximum rematch attempts',
    group: 'Matching',
    unit: 'providers',
  },
  'matching.same_provider_bonus': {
    label: 'Same-provider consolidation bonus',
    group: 'Matching',
    unit: 'ranking points',
  },
  'requests.default_ground_transport_minutes': {
    label: 'Default ground transport window',
    group: 'Requests',
    unit: 'minutes',
  },
  'requests.guest_link_ttl_hours': {
    label: 'Guest link validity',
    group: 'Client access',
    unit: 'hours',
  },
  'sla.acknowledgement_minutes.default': {
    label: 'Acknowledgement window',
    group: 'Acknowledgement SLA',
    unit: 'minutes',
  },
  'sla.acknowledgement_minutes.urgent': {
    label: 'Acknowledgement window — urgent',
    group: 'Acknowledgement SLA',
    unit: 'minutes',
  },
};

export const FLAG_LABELS: Readonly<Record<string, SettingLabel>> = {
  'ai.intake_enabled': { label: 'AI request reading', group: 'AI' },
  'ai.matching_enabled': { label: 'AI provider selection', group: 'AI' },
  'ai.research_assistant_enabled': { label: 'Research assistant', group: 'AI' },
  'client.guest_requests_enabled': { label: 'Guest requests', group: 'Client access' },
  'notifications.sms_enabled': { label: 'SMS chasing', group: 'Notifications' },
};

/** `matching.max_rematch_attempts` → `Matching max rematch attempts`. */
function humaniseKey(key: string): string {
  const words = key.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function settingLabel(key: string): SettingLabel {
  return SETTING_LABELS[key] ?? { label: humaniseKey(key), group: 'Requests' };
}

export function flagLabel(key: string): SettingLabel {
  return FLAG_LABELS[key] ?? { label: humaniseKey(key), group: 'AI' };
}

/**
 * Groups rows for display, in a deliberate order.
 *
 * Matching and the SLA come first because they are what an administrator changes when
 * something is going wrong, which is when they are most likely to be on this page.
 */
const GROUP_ORDER: readonly SettingLabel['group'][] = [
  'Matching',
  'Acknowledgement SLA',
  'Requests',
  'AI',
  'Client access',
  'Notifications',
];

export function groupByArea<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  labelOf: (key: string) => SettingLabel,
): readonly { readonly group: string; readonly rows: readonly T[] }[] {
  const byGroup = new Map<string, T[]>();

  for (const row of rows) {
    const group = labelOf(keyOf(row)).group;
    const existing = byGroup.get(group) ?? [];
    existing.push(row);
    byGroup.set(group, existing);
  }

  return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
    group,
    // Stable within a group, so the page does not reshuffle between loads.
    rows: (byGroup.get(group) ?? []).sort((a, b) =>
      labelOf(keyOf(a)).label.localeCompare(labelOf(keyOf(b)).label),
    ),
  }));
}
