import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScriptedAdapter, runStructured, setAiAdapterForTests } from '@/ai/client';
import { matchingSelectionPrompt, type MatchingCandidateInput } from '@/ai/matching/prompt';
import { isAiEnabled, getEnv } from '@/lib/config/env';

/**
 * The matching eval (CLAUDE.md §26, §10).
 *
 * The metric that has to approach 100% is **validity**: the chosen id is one of the
 * candidates supplied. Everything else is a preference. A model that picks a provider
 * nobody offered is not making a worse choice — it is making no choice at all, and the
 * deterministic fallback has to clean up after it.
 *
 * Agreement with the deterministic top rank is measured but deliberately **not** required
 * to be high. If the model always agreed there would be no reason to ask it; §10 lists the
 * judgements it is there to make — spare capacity, fewer hand-offs, lead-time margin. What
 * matters is that every disagreement is still a provably eligible candidate, which
 * `verifySelection` enforces in production and which this suite re-checks here.
 *
 * Offline, the scripted adapter plays the part of a model with a range of behaviours,
 * including the ones that break things: an id that was never offered, prose instead of
 * JSON, a timeout. The point of the offline run is that all of them end in a valid
 * selection anyway.
 */

const ONLINE = isAiEnabled(getEnv());

interface MatchingCase {
  readonly id: string;
  readonly description: string;
  readonly candidates: readonly MatchingCandidateInput[];
  /** The deterministic engine's own top choice — position 1. */
  readonly deterministicTopId: string;
}

function candidate(
  overrides: Partial<MatchingCandidateInput> & { providerCompanyId: string; deterministicPosition: number },
): MatchingCandidateInput {
  return {
    displayName: `Provider ${overrides.providerCompanyId}`,
    platformRank: 10,
    spareCapacity: 2,
    leadTimeMarginMinutes: 240,
    alreadyServingThisRequest: false,
    deterministicScore: 1000 - overrides.deterministicPosition * 10,
    ...overrides,
  };
}

const CASES: readonly MatchingCase[] = [
  {
    id: 'two-clear',
    description: 'two candidates, one plainly better ranked',
    candidates: [
      candidate({ providerCompanyId: 'p-alpha', deterministicPosition: 1, platformRank: 1, displayName: 'Meridian Ground' }),
      candidate({ providerCompanyId: 'p-beta', deterministicPosition: 2, platformRank: 20, displayName: 'Hudson Executive' }),
    ],
    deterministicTopId: 'p-alpha',
  },
  {
    id: 'capacity-argument',
    description: 'the lower-ranked candidate has far more spare capacity',
    candidates: [
      candidate({ providerCompanyId: 'p-alpha', deterministicPosition: 1, platformRank: 1, spareCapacity: 1 }),
      candidate({ providerCompanyId: 'p-beta', deterministicPosition: 2, platformRank: 5, spareCapacity: 9 }),
    ],
    deterministicTopId: 'p-alpha',
  },
  {
    id: 'consolidation',
    description: 'one candidate is already serving another line on this request',
    candidates: [
      candidate({ providerCompanyId: 'p-alpha', deterministicPosition: 1, platformRank: 2 }),
      candidate({
        providerCompanyId: 'p-beta',
        deterministicPosition: 2,
        platformRank: 4,
        alreadyServingThisRequest: true,
      }),
    ],
    deterministicTopId: 'p-alpha',
  },
  {
    id: 'lead-time-margin',
    description: 'one candidate is only just inside its lead time',
    candidates: [
      candidate({ providerCompanyId: 'p-alpha', deterministicPosition: 1, leadTimeMarginMinutes: 15 }),
      candidate({ providerCompanyId: 'p-beta', deterministicPosition: 2, leadTimeMarginMinutes: 600 }),
    ],
    deterministicTopId: 'p-alpha',
  },
  {
    id: 'single-candidate',
    description: 'only one eligible provider — there is nothing to weigh',
    candidates: [candidate({ providerCompanyId: 'p-only', deterministicPosition: 1 })],
    deterministicTopId: 'p-only',
  },
  {
    id: 'five-way',
    description: 'a crowded shortlist',
    candidates: [
      candidate({ providerCompanyId: 'p-1', deterministicPosition: 1, platformRank: 1 }),
      candidate({ providerCompanyId: 'p-2', deterministicPosition: 2, platformRank: 3, spareCapacity: 6 }),
      candidate({ providerCompanyId: 'p-3', deterministicPosition: 3, platformRank: 5 }),
      candidate({ providerCompanyId: 'p-4', deterministicPosition: 4, platformRank: 8, spareCapacity: 12 }),
      candidate({ providerCompanyId: 'p-5', deterministicPosition: 5, platformRank: 12 }),
    ],
    deterministicTopId: 'p-1',
  },
];

function promptInput(testCase: MatchingCase) {
  return {
    requestReference: `RQ-EVAL-${testCase.id.toUpperCase()}`,
    airportLabel: 'KTEB · Teterboro Airport',
    fboName: 'Signature Flight Support',
    serviceName: 'Ground transport',
    quantity: 2,
    unitLabel: 'vehicle',
    serviceWindowLocal: 'Fri 06 Mar · 03:00 — 06:00 local',
    requirementsSummary: 'vehicleClass: suv, passengers: 4',
    passengerCount: 4,
    candidates: testCase.candidates,
  };
}

interface Outcome {
  readonly id: string;
  readonly chosenId: string | null;
  readonly valid: boolean;
  readonly agreedWithDeterministic: boolean;
  readonly gaveReason: boolean;
  readonly latencyMs: number;
  readonly failed: boolean;
}

let outcomes: Outcome[] = [];

beforeAll(async () => {
  if (!ONLINE) {
    // Offline the adapter plays a plausible model: it picks the candidate with the most
    // spare capacity, which is a judgement §10 explicitly permits and which disagrees with
    // the deterministic order often enough to be worth measuring.
    setAiAdapterForTests(
      createScriptedAdapter({
        fallback: (promptId, input) => {
          if (promptId !== matchingSelectionPrompt.id) {
            return { kind: 'failure', reason: 'unavailable' };
          }
          const candidates = (input as { candidates: readonly MatchingCandidateInput[] }).candidates;
          const best = [...candidates].sort(
            (a, b) => b.spareCapacity - a.spareCapacity || a.deterministicPosition - b.deterministicPosition,
          )[0];

          return {
            kind: 'data',
            value: {
              chosenProviderId: best?.providerCompanyId ?? 'nobody',
              reason: 'Chosen for the largest spare capacity among the eligible candidates.',
              confidence: 'medium',
              considerations: ['spare capacity', 'deterministic position'],
            },
          };
        },
        modelName: 'scripted-matcher',
      }),
    );
  }

  outcomes = [];
  for (const testCase of CASES) {
    const startedAt = Date.now();
    const result = await runStructured(matchingSelectionPrompt, promptInput(testCase), {
      actorUserId: null,
    });
    const latencyMs = Date.now() - startedAt;

    if (!result.ok) {
      outcomes.push({
        id: testCase.id,
        chosenId: null,
        valid: false,
        agreedWithDeterministic: false,
        gaveReason: false,
        latencyMs,
        failed: true,
      });
      continue;
    }

    const offeredIds = new Set(testCase.candidates.map((entry) => entry.providerCompanyId));

    outcomes.push({
      id: testCase.id,
      chosenId: result.data.chosenProviderId,
      valid: offeredIds.has(result.data.chosenProviderId),
      agreedWithDeterministic: result.data.chosenProviderId === testCase.deterministicTopId,
      gaveReason: result.data.reason.trim().length >= 10,
      latencyMs,
      failed: false,
    });
  }
}, 300_000);

afterAll(() => {
  setAiAdapterForTests(undefined);
});

describe('matching selection', () => {
  it('reports its metrics', () => {
    const answered = outcomes.filter((outcome) => !outcome.failed);
    const validity = answered.length === 0 ? 0 : answered.filter((o) => o.valid).length / answered.length;
    const agreement =
      answered.length === 0 ? 0 : answered.filter((o) => o.agreedWithDeterministic).length / answered.length;
    const fallbackRate = outcomes.filter((o) => o.failed).length / outcomes.length;
    const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);

    console.log(
      [
        ``,
        `matching eval (${ONLINE ? 'online' : 'offline'}) — ${String(outcomes.length)} cases`,
        `  ${'─'.repeat(44)}`,
        `  validity               ${(validity * 100).toFixed(1)}%`,
        `  agreement with top-1   ${(agreement * 100).toFixed(1)}%`,
        `  fallback rate          ${(fallbackRate * 100).toFixed(1)}%`,
        `  latency p50            ${String(latencies[Math.floor(latencies.length / 2)] ?? 0)}ms`,
        ``,
      ].join('\n'),
    );

    expect(outcomes).toHaveLength(CASES.length);
  });

  /**
   * §26: "validity rate: must approach 100%".
   *
   * Every answered call must name a provider that was actually on the shortlist. This is
   * the whole contract between the engine and the model.
   */
  it('always chooses a provider that was on the shortlist', () => {
    const invalid = outcomes.filter((outcome) => !outcome.failed && !outcome.valid);
    expect(invalid.map((outcome) => `${outcome.id} chose ${String(outcome.chosenId)}`)).toEqual([]);
  });

  it('gives a reason an operator can read in the trace', () => {
    const silent = outcomes.filter((outcome) => !outcome.failed && !outcome.gaveReason);
    expect(silent.map((outcome) => outcome.id)).toEqual([]);
  });

  it('has nothing to weigh when there is one candidate, and picks it', () => {
    const single = outcomes.find((outcome) => outcome.id === 'single-candidate');
    expect(single?.chosenId).toBe('p-only');
  });

  it('answers within a usable latency', () => {
    const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
    expect(p95).toBeLessThanOrEqual(ONLINE ? 25_000 : 500);
  });
});

describe('the model cannot break matching however it misbehaves', () => {
  const shortlist = CASES[0]!;

  async function attempt(outcome: Parameters<typeof createScriptedAdapter>[0]) {
    setAiAdapterForTests(createScriptedAdapter(outcome));
    return runStructured(matchingSelectionPrompt, promptInput(shortlist), { actorUserId: null });
  }

  it('an id that was never offered is caught by the caller, not trusted', async () => {
    const result = await attempt({
      fallback: () => ({
        kind: 'data',
        value: {
          chosenProviderId: 'p-does-not-exist',
          reason: 'A provider I invented because it sounded good.',
          confidence: 'high',
          considerations: [],
        },
      }),
    });

    // The schema cannot know which ids were offered — that is `verifySelection`'s job, and
    // it has its own property test. What this asserts is that the adapter hands the caller
    // the raw claim rather than silently substituting something.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.chosenProviderId).toBe('p-does-not-exist');
  });

  it('prose instead of JSON fails validation rather than being half-parsed', async () => {
    const result = await attempt({
      fallback: () => ({ kind: 'raw', text: 'I think Meridian Ground would be the best choice here.' }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema_invalid');
  });

  it('a structurally valid but empty reason is rejected by the schema', async () => {
    const result = await attempt({
      fallback: () => ({
        kind: 'data',
        value: { chosenProviderId: 'p-alpha', reason: '', confidence: 'high', considerations: [] },
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema_invalid');
  });

  it('a timeout is reported as a timeout, not as an answer', async () => {
    const result = await attempt({ fallback: () => ({ kind: 'failure', reason: 'timeout' }) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
  });

  it('an unavailable provider is reported as unavailable', async () => {
    const result = await attempt({ fallback: () => ({ kind: 'failure', reason: 'unavailable' }) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
  });

  it('a refusal is reported as a refusal', async () => {
    const result = await attempt({ fallback: () => ({ kind: 'failure', reason: 'refused' }) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('refused');
  });
});
