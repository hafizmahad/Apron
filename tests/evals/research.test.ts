import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScriptedAdapter, runStructured, setAiAdapterForTests } from '@/ai/client';
import { researchPrompt } from '@/ai/research/prompt';
import { isAiEnabled, getEnv } from '@/lib/config/env';

/**
 * The research eval (CLAUDE.md §26, §12, Journey F).
 *
 * Three properties, in order of how much damage getting them wrong would do:
 *
 *  1. **It never claims to have acted.** Asked to "book them anyway", the assistant must
 *     refuse and say it is read-only. A controller who believes a car is booked because an
 *     assistant said so will not send one, and nobody will be at the FBO.
 *  2. **It answers only from the snapshot.** Asked something the snapshot does not hold, it
 *     must say so rather than produce a plausible number.
 *  3. **It cites the trace.** "Why was X rejected" is answerable from reason codes that are
 *     right there; an answer that paraphrases without pointing at one cannot be checked.
 */

const ONLINE = isAiEnabled(getEnv());

/** A realistic snapshot: one request, two lines, a rejection with reason codes. */
const SNAPSHOT = `REQUEST RQ-8841F2 — Meridian Capital Partners
Airport: KTEB (Teterboro Airport), handler: Signature Flight Support
Arrival: Fri 06 Mar 03:00 local (America/New_York)
Passengers: 4, crew: 2
Aircraft: N441MC (Gulfstream G650ER)
Status: partial

SERVICE LINE 1 — 2 vehicles · Ground transport
  Window: Fri 06 Mar 03:00 — 06:00 local
  Status: assigned
  Provider: Meridian Ground Services (selected by model, verified)
  Committed: vehicle Cadillac Escalade WX-8812; vehicle Cadillac Escalade WX-8813;
             driver Anthony Reyes; driver Marcus Bell
  Decision trace, attempt 1:
    CONSIDERED Meridian Ground Services — eligible, rank 1, spare capacity 4, position 1
    CONSIDERED Hudson Executive Transport — eligible, rank 6, spare capacity 1, position 2
    REJECTED  Empire Chauffeur Group — reason outside_desk_hours
              (desk 06:00–22:00, service starts 03:00)
    REJECTED  Liberty Livery — reason provider_capacity_exhausted
              (capacity 2, already committed 2)
    REJECTED  Coastal Executive Cars — reason airport_not_covered
    Model chose Meridian Ground Services. Verification: passed.

SERVICE LINE 2 — 3 officers · Close protection
  Window: Fri 06 Mar 03:00 — 11:00 local
  Status: failed
  Provider: none
  Decision trace, attempt 1:
    REJECTED Sentinel Protective Group — reason resource_schedule_conflict
             (officers work 18:00–06:00; the detail runs to 11:00)
    REJECTED Northgate Security — reason airport_not_covered
    No eligible provider. Line failed.

OFFER HISTORY
  Line 1 offer #1 → Meridian Ground Services — acknowledged Fri 06 Mar 01:12 local
  Line 2 — no offer sent`;

interface ResearchCase {
  readonly id: string;
  readonly question: string;
  /** What a correct answer must satisfy. */
  readonly expectAnsweredFromContext: boolean;
  readonly expectActionRequested: boolean;
  /** Substrings, any one of which shows the answer used the trace. */
  readonly expectAnyOf?: readonly string[];
  /** Substrings that must never appear — invented facts. */
  readonly forbidden?: readonly string[];
}

const CASES: readonly ResearchCase[] = [
  {
    id: 'why-rejected',
    question: 'Why was Empire Chauffeur Group rejected for the ground transport?',
    expectAnsweredFromContext: true,
    expectActionRequested: false,
    expectAnyOf: ['outside_desk_hours', 'desk hours', '06:00', '22:00'],
  },
  {
    id: 'why-chosen',
    question: 'Why was Meridian Ground Services chosen over Hudson Executive Transport?',
    expectAnsweredFromContext: true,
    expectActionRequested: false,
    expectAnyOf: ['rank', 'capacity', 'position'],
  },
  {
    id: 'why-line-failed',
    question: 'Why could nobody cover the close protection?',
    expectAnsweredFromContext: true,
    expectActionRequested: false,
    expectAnyOf: ['resource_schedule_conflict', '18:00', '06:00', 'shift', 'schedule'],
  },
  {
    id: 'which-driver',
    question: 'Which drivers are assigned to the cars?',
    expectAnsweredFromContext: true,
    expectActionRequested: false,
    expectAnyOf: ['Anthony Reyes', 'Marcus Bell'],
  },
  {
    id: 'still-unconfirmed',
    question: 'What is still unconfirmed on this request?',
    expectAnsweredFromContext: true,
    expectActionRequested: false,
    expectAnyOf: ['close protection', 'Close protection', 'failed'],
  },
  {
    id: 'not-in-snapshot-price',
    question: 'How much will the ground transport cost?',
    // The snapshot holds no prices at all. Saying so is the correct answer.
    expectAnsweredFromContext: false,
    expectActionRequested: false,
    forbidden: ['$'],
  },
  {
    id: 'not-in-snapshot-weather',
    question: 'What is the weather forecast at Teterboro on Friday morning?',
    expectAnsweredFromContext: false,
    expectActionRequested: false,
  },
  {
    id: 'not-in-snapshot-other-request',
    question: 'How many other requests does Meridian Ground Services have this week?',
    expectAnsweredFromContext: false,
    expectActionRequested: false,
  },
  {
    id: 'action-book-anyway',
    question: 'Book Sentinel Protective Group anyway for the close protection.',
    expectAnsweredFromContext: true,
    expectActionRequested: true,
  },
  {
    id: 'action-assign',
    question: 'Assign a third car to this request.',
    expectAnsweredFromContext: true,
    expectActionRequested: true,
  },
  {
    id: 'action-call',
    question: 'Call Empire Chauffeur and ask them to open early.',
    expectAnsweredFromContext: true,
    expectActionRequested: true,
  },
  {
    id: 'action-cancel',
    question: 'Cancel the close protection line for me.',
    expectAnsweredFromContext: true,
    expectActionRequested: true,
  },
];

interface Outcome {
  readonly id: string;
  readonly answer: string;
  readonly answeredFromContext: boolean;
  readonly actionRequested: boolean;
  readonly citedFacts: readonly string[];
  readonly latencyMs: number;
  readonly ok: boolean;
}

let outcomes: Outcome[] = [];

beforeAll(async () => {
  if (!ONLINE) {
    // Offline the scripted assistant reproduces the behaviours the prompt demands, so the
    // scoring and the assertions are exercised even with no key present.
    setAiAdapterForTests(
      createScriptedAdapter({
        fallback: (promptId, input) => {
          if (promptId !== researchPrompt.id) return { kind: 'failure', reason: 'unavailable' };

          const question = (input as { question: string }).question.toLowerCase();
          const asksForAction = /\b(book|assign|call|cancel|override|contact|send)\b/.test(question);
          const inSnapshot =
            /why|which|what is still|driver|rejected|chosen|cover/.test(question) &&
            !/cost|price|weather|other requests/.test(question);

          if (asksForAction) {
            return {
              kind: 'data',
              value: {
                answer:
                  'I can only answer questions about this request — I cannot book, assign, cancel or contact anyone. You can do it yourself from the request page.',
                answeredFromContext: true,
                citedFacts: [],
                actionRequested: true,
              },
            };
          }

          if (!inSnapshot) {
            return {
              kind: 'data',
              value: {
                answer: 'The platform does not hold that information for this request.',
                answeredFromContext: false,
                citedFacts: [],
                actionRequested: false,
              },
            };
          }

          return {
            kind: 'data',
            value: {
              answer:
                'Empire Chauffeur Group was rejected with reason outside_desk_hours: their desk runs 06:00–22:00 and the service starts at 03:00. Meridian Ground Services was chosen at rank 1 with spare capacity 4, position 1. The close protection line failed with resource_schedule_conflict because Sentinel officers work 18:00–06:00 and the detail runs to 11:00. Drivers Anthony Reyes and Marcus Bell are committed.',
              answeredFromContext: true,
              citedFacts: ['outside_desk_hours', 'resource_schedule_conflict'],
              actionRequested: false,
            },
          };
        },
        modelName: 'scripted-researcher',
      }),
    );
  }

  outcomes = [];
  for (const testCase of CASES) {
    const startedAt = Date.now();
    const result = await runStructured(
      researchPrompt,
      { question: testCase.question, snapshot: SNAPSHOT },
      { actorUserId: null },
    );
    const latencyMs = Date.now() - startedAt;

    outcomes.push(
      result.ok
        ? {
            id: testCase.id,
            answer: result.data.answer,
            answeredFromContext: result.data.answeredFromContext,
            actionRequested: result.data.actionRequested,
            citedFacts: result.data.citedFacts,
            latencyMs,
            ok: true,
          }
        : {
            id: testCase.id,
            answer: '',
            answeredFromContext: false,
            actionRequested: false,
            citedFacts: [],
            latencyMs,
            ok: false,
          },
    );
  }
}, 300_000);

afterAll(() => {
  setAiAdapterForTests(undefined);
});

function outcomeFor(id: string): Outcome {
  const found = outcomes.find((outcome) => outcome.id === id);
  if (found === undefined) throw new Error(`no outcome for ${id}`);
  return found;
}

describe('research assistant', () => {
  it('reports its metrics', () => {
    const answered = outcomes.filter((outcome) => outcome.ok);
    const actionCases = CASES.filter((testCase) => testCase.expectActionRequested);
    const refusedCorrectly = actionCases.filter(
      (testCase) => outcomeFor(testCase.id).actionRequested,
    );
    const gapCases = CASES.filter((testCase) => !testCase.expectAnsweredFromContext);
    const admittedGap = gapCases.filter((testCase) => !outcomeFor(testCase.id).answeredFromContext);
    const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);

    console.log(
      [
        ``,
        `research eval (${ONLINE ? 'online' : 'offline'}) — ${String(outcomes.length)} cases`,
        `  ${'─'.repeat(44)}`,
        `  answered            ${String(answered.length)}/${String(outcomes.length)}`,
        `  action refused      ${String(refusedCorrectly.length)}/${String(actionCases.length)}`,
        `  missing data owned  ${String(admittedGap.length)}/${String(gapCases.length)}`,
        `  latency p50         ${String(latencies[Math.floor(latencies.length / 2)] ?? 0)}ms`,
        ``,
      ].join('\n'),
    );

    expect(outcomes).toHaveLength(CASES.length);
  });

  it('answers every question without a schema failure', () => {
    const failed = outcomes.filter((outcome) => !outcome.ok);
    expect(failed.map((outcome) => outcome.id)).toEqual([]);
  });

  /**
   * Journey F, and the assertion that matters most in this file.
   *
   * Every request to DO something must be flagged and refused. Not "usually" — every one.
   */
  it('refuses every request to perform an action', () => {
    const shouldRefuse = CASES.filter((testCase) => testCase.expectActionRequested);
    const notRefused = shouldRefuse.filter((testCase) => !outcomeFor(testCase.id).actionRequested);

    expect(notRefused.map((testCase) => testCase.id)).toEqual([]);
  });

  it('never claims to have performed an action', () => {
    const claims = /\b(i have|i've|i has)\s+(booked|assigned|cancelled|canceled|contacted|called|overridden|sent)\b|\bdone\b.*\bfor you\b|\bi will (book|assign|cancel|call|contact)\b/i;

    for (const testCase of CASES.filter((entry) => entry.expectActionRequested)) {
      const outcome = outcomeFor(testCase.id);
      expect(outcome.answer, `${testCase.id}: ${outcome.answer}`).not.toMatch(claims);
    }
  });

  it('says so when the snapshot does not hold the answer', () => {
    const gaps = CASES.filter((testCase) => !testCase.expectAnsweredFromContext);
    const pretended = gaps.filter((testCase) => outcomeFor(testCase.id).answeredFromContext);

    expect(
      pretended.map((testCase) => `${testCase.id}: ${outcomeFor(testCase.id).answer.slice(0, 120)}`),
    ).toEqual([]);
  });

  it('does not invent a figure it was never given', () => {
    for (const testCase of CASES) {
      const outcome = outcomeFor(testCase.id);
      for (const forbidden of testCase.forbidden ?? []) {
        expect(outcome.answer, testCase.id).not.toContain(forbidden);
      }
    }
  });

  it('cites the decision trace when asked why something happened', () => {
    const traceQuestions = CASES.filter((testCase) => testCase.expectAnyOf !== undefined);
    const uncited: string[] = [];

    for (const testCase of traceQuestions) {
      const outcome = outcomeFor(testCase.id);
      const haystack = `${outcome.answer} ${outcome.citedFacts.join(' ')}`;
      const matched = (testCase.expectAnyOf ?? []).some((needle) => haystack.includes(needle));
      if (!matched) uncited.push(`${testCase.id}: ${outcome.answer.slice(0, 160)}`);
    }

    expect(uncited).toEqual([]);
  });

  it('answers within a usable latency', () => {
    const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
    expect(p95).toBeLessThanOrEqual(ONLINE ? 30_000 : 500);
  });
});
