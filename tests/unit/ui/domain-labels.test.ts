import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_STRATEGY_LABELS,
  AI_STAGE_LABELS,
  AUDIT_ACTION_LABELS,
  assignmentStrategyHint,
  assignmentStrategyLabel,
  aiStageLabel,
  aiErrorLabel,
  auditActionLabel,
} from '@/lib/domain-labels';
import { assignmentStrategies, aiStages } from '@/db/schema/enums';

/**
 * No internal identifier is ever the primary text a user reads (CLAUDE.md §21).
 *
 * The labels are presentation only — the enum member remains the identity in the database,
 * the matching engine and the audit trail. What this guards is drift: somebody adds a
 * strategy or a stage, nobody adds a label, and `catering_order` appears as the headline of
 * a card in an otherwise finished console.
 *
 * Compared against the real enums rather than a second hand-written list, so the test
 * cannot go stale in the same way the labels might.
 */

describe('assignment strategies read as product language', () => {
  it('labels every strategy the schema defines', () => {
    const missing = assignmentStrategies.filter(
      (strategy) => ASSIGNMENT_STRATEGY_LABELS[strategy] === undefined,
    );
    expect(missing, `add these to ASSIGNMENT_STRATEGY_LABELS: ${missing.join(', ')}`).toEqual([]);
  });

  it('never gives back the raw value as the label', () => {
    for (const strategy of assignmentStrategies) {
      const label = assignmentStrategyLabel(strategy);
      expect(label, strategy).not.toBe(strategy);
      expect(label, strategy).not.toMatch(/_/);
    }
  });

  it('explains what each strategy means for matching', () => {
    for (const strategy of assignmentStrategies) {
      expect(assignmentStrategyHint(strategy).length, strategy).toBeGreaterThan(20);
    }
  });

  it('renders the exact examples that were reported as raw', () => {
    expect(assignmentStrategyLabel('vehicle_with_driver')).toBe('Vehicle with driver');
    expect(assignmentStrategyLabel('hotel_rooms')).toBe('Hotel rooms');
    expect(assignmentStrategyLabel('catering_order')).toBe('Catering order');
  });
});

describe('AI stages and failures read as product language', () => {
  it('labels every stage the schema defines', () => {
    const missing = aiStages.filter((stage) => AI_STAGE_LABELS[stage] === undefined);
    expect(missing, `add these to AI_STAGE_LABELS: ${missing.join(', ')}`).toEqual([]);
  });

  it('turns a failure category into a sentence a person can act on', () => {
    expect(aiErrorLabel('schema_invalid')).toMatch(/schema/i);
    expect(aiErrorLabel('timeout')).toMatch(/time/i);
    expect(aiErrorLabel(null)).toBe('No failure recorded');
  });

  it('never shows a bare stage identifier', () => {
    for (const stage of aiStages) {
      expect(aiStageLabel(stage), stage).not.toBe(stage);
    }
  });
});

describe('audit actions read as events, not identifiers', () => {
  it('names the actions the product actually writes', () => {
    // A representative set spanning governance, lifecycle and provider self-management.
    const cases: readonly [string, RegExp][] = [
      ['provider_company.approve', /approved/i],
      ['provider_company.suspend', /suspended/i],
      ['request.cancel', /cancelled/i],
      ['request.override_provider', /overrid/i],
      ['offer.acknowledged', /accepted/i],
      ['offer.expired', /expired/i],
      ['assignment.create', /committed/i],
      ['document.generate', /generated/i],
      ['provider.add_vehicle', /vehicle/i],
      ['settings.update', /setting/i],
    ];

    for (const [action, pattern] of cases) {
      expect(auditActionLabel(action), action).toMatch(pattern);
    }
  });

  it('never returns a dotted identifier as the label', () => {
    // Exercise the whole map, not a sample.
    for (const action of Object.keys(AUDIT_ACTION_LABELS)) {
      expect(auditActionLabel(action), action).not.toMatch(/\./);
    }
  });

  it('humanises an unrecognised action rather than rendering nothing', () => {
    expect(auditActionLabel('something.brand_new')).toBe('Something brand new');
  });
});
