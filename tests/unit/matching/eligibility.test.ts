import { describe, expect, it } from 'vitest';
import { couldProviderCover, evaluateAndRank, type EligibilityResult } from '@/domain/matching';
import { emptyProviderResources } from '@/domain/matching';
import {
  DAYTIME,
  FBO_ID,
  G650ER,
  HANGAR_SERVICE_ID,
  NEVER,
  OTHER_AIRPORT_ID,
  OTHER_FBO_ID,
  OVERNIGHT,
  PC24,
  makeCandidate,
  makeContext,
  makeCoverage,
  makeDriver,
  makeHangar,
  makeLine,
  makeOfficer,
  makeVehicle,
  utc,
  window,
} from '../../helpers/matching';

/**
 * The deterministic oracle, checked case by case (CLAUDE.md §9).
 *
 * Every test changes exactly one thing away from an eligible baseline, so a failure names
 * its own cause. The reason codes asserted here are the same strings the decision trace
 * renders and the research assistant cites, which is why they are asserted exactly rather
 * than merely "is ineligible".
 */

function reasonsFor(result: EligibilityResult): string[] {
  return [...result.reasonCodes];
}

describe('baseline', () => {
  it('an approved, covering, staffed provider with a free vehicle and driver is eligible', () => {
    const result = couldProviderCover(makeContext(), makeLine(), makeCandidate());
    expect(result.eligible).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expect(result.spareCapacity).toBe(4);
    expect(result.feasibleResourceIds.length).toBe(2); // one vehicle, one driver
  });
});

describe('provider governance', () => {
  it('rejects a provider awaiting approval', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ status: 'pending' }),
    );
    expect(result.eligible).toBe(false);
    expect(reasonsFor(result)).toContain('provider_not_approved');
  });

  it('rejects a suspended provider even with perfect coverage and resources', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ status: 'suspended' }),
    );
    expect(reasonsFor(result)).toContain('provider_not_approved');
  });

  it('rejects an inactive provider', () => {
    const result = couldProviderCover(makeContext(), makeLine(), makeCandidate({ active: false }));
    expect(reasonsFor(result)).toContain('provider_inactive');
  });

  it('rejects a provider excluded after a previous decline', () => {
    const result = couldProviderCover(
      makeContext({ excludedProviderIds: ['provider-1'] }),
      makeLine(),
      makeCandidate(),
    );
    expect(reasonsFor(result)).toContain('provider_excluded_by_previous_decline');
  });

  it('reports every applicable reason at once rather than the first', () => {
    const result = couldProviderCover(
      makeContext({ excludedProviderIds: ['provider-1'] }),
      makeLine(),
      makeCandidate({ status: 'pending', active: false }),
    );
    expect(reasonsFor(result)).toEqual(
      expect.arrayContaining([
        'provider_not_approved',
        'provider_inactive',
        'provider_excluded_by_previous_decline',
      ]),
    );
  });
});

describe('coverage', () => {
  it('rejects a provider covering a different airport', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ airportId: OTHER_AIRPORT_ID }) }),
    );
    expect(reasonsFor(result)).toContain('airport_not_covered');
  });

  it('rejects a provider offering a different service', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ serviceCategoryId: 'svc-catering' }) }),
    );
    expect(reasonsFor(result)).toContain('service_not_offered');
  });

  it('rejects a switched-off coverage row', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ active: false }) }),
    );
    expect(reasonsFor(result)).toContain('coverage_inactive');
  });

  it('airport-wide coverage satisfies a request naming any FBO at that airport', () => {
    const result = couldProviderCover(
      makeContext({ fboId: FBO_ID }),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ fboId: null }) }),
    );
    expect(result.eligible).toBe(true);
  });

  it('FBO-scoped coverage satisfies only a request naming that same FBO', () => {
    const eligible = couldProviderCover(
      makeContext({ fboId: FBO_ID }),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ fboId: FBO_ID }) }),
    );
    expect(eligible.eligible).toBe(true);

    const wrongFbo = couldProviderCover(
      makeContext({ fboId: OTHER_FBO_ID }),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ fboId: FBO_ID }) }),
    );
    expect(reasonsFor(wrongFbo)).toContain('fbo_not_covered');
  });

  it('FBO-scoped coverage does not satisfy a request that names no FBO', () => {
    const result = couldProviderCover(
      makeContext({ fboId: null }),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ fboId: FBO_ID }) }),
    );
    expect(reasonsFor(result)).toContain('fbo_not_covered');
  });
});

describe('timing', () => {
  it('rejects a request inside the provider lead time', () => {
    const result = couldProviderCover(
      // 07:00 window, evaluated at 06:30 — 30 minutes' notice against a 90-minute lead time.
      makeContext({ evaluationNow: utc('06:30') }),
      makeLine(),
      makeCandidate(),
    );
    expect(reasonsFor(result)).toContain('lead_time_insufficient');
    expect(result.leadTimeMarginMinutes).toBe(-60);
  });

  it('accepts a request exactly at the lead-time boundary', () => {
    const result = couldProviderCover(
      makeContext({ evaluationNow: utc('05:30') }),
      makeLine(),
      makeCandidate(),
    );
    expect(result.eligible).toBe(true);
    expect(result.leadTimeMarginMinutes).toBe(0);
  });

  it('rejects a booking further ahead than the provider accepts', () => {
    const result = couldProviderCover(
      // Evaluating 40 days early against a 30-day ceiling.
      makeContext({ evaluationNow: new Date(utc('07:00').getTime() - 40 * 86_400_000) }),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ maxNoticeDays: 30 }) }),
    );
    expect(reasonsFor(result)).toContain('booked_too_far_ahead');
  });

  it('rejects a window outside the staffed desk hours', () => {
    // 07:00-10:00Z is 03:00-06:00 in New York — before a 06:00 desk opens.
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ schedule: DAYTIME }) }),
    );
    expect(reasonsFor(result)).toContain('outside_desk_hours');
  });

  it('accepts an overnight arrival at a desk whose hours cross midnight', () => {
    // The overnight desk runs 18:00-06:00 local, which covers 03:00-06:00 local exactly.
    const result = couldProviderCover(
      makeContext(),
      makeLine({ serviceWindow: window('07:00', '09:00') }),
      makeCandidate({ coverage: makeCoverage({ schedule: OVERNIGHT }) }),
    );
    expect(result.eligible).toBe(true);
  });

  it('treats an empty non-24/7 schedule as never open, not always open', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ coverage: makeCoverage({ schedule: NEVER }) }),
    );
    expect(reasonsFor(result)).toContain('outside_desk_hours');
  });

  it('rejects a window that only partially falls inside desk hours', () => {
    // Desk opens 06:00 local (10:00Z). A 09:00-12:00Z window starts an hour early.
    const result = couldProviderCover(
      makeContext({ evaluationNow: utc('00:00') }),
      makeLine({ serviceWindow: window('09:00', '12:00') }),
      makeCandidate({ coverage: makeCoverage({ schedule: DAYTIME }) }),
    );
    expect(reasonsFor(result)).toContain('outside_desk_hours');
  });

  it('rejects a window covered by a blackout', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        blackouts: [{ interval: window('06:00', '12:00'), reason: 'Depot closed' }],
      }),
    );
    expect(reasonsFor(result)).toContain('blackout_window');
  });

  it('ignores a blackout that merely touches the window boundary', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        blackouts: [{ interval: window('10:00', '12:00'), reason: 'Depot closed' }],
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('reports an unresolved service window rather than guessing', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({ serviceWindow: null }),
      makeCandidate(),
    );
    expect(reasonsFor(result)).toContain('service_window_unknown');
    expect(result.leadTimeMarginMinutes).toBeNull();
  });
});

describe('capacity', () => {
  it('rejects when committed units leave less than the line needs', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({ quantity: 2 }),
      makeCandidate({ coverage: makeCoverage({ totalCapacity: 4, committedUnitsInWindow: 3 }) }),
    );
    expect(reasonsFor(result)).toContain('provider_capacity_exhausted');
    expect(result.spareCapacity).toBe(0);
  });

  it('accepts when spare capacity exactly equals the requested quantity', () => {
    const candidate = makeCandidate({
      coverage: makeCoverage({ totalCapacity: 4, committedUnitsInWindow: 2 }),
      resources: {
        ...emptyProviderResources,
        vehicles: [makeVehicle(), makeVehicle()],
        drivers: [makeDriver(), makeDriver()],
      },
    });
    const result = couldProviderCover(makeContext(), makeLine({ quantity: 2 }), candidate);
    expect(result.eligible).toBe(true);
    expect(result.spareCapacity).toBe(2);
  });
});

describe('ground transport rules', () => {
  it('rejects a provider with no vehicles at all', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ resources: { ...emptyProviderResources, drivers: [makeDriver()] } }),
    );
    expect(reasonsFor(result)).toContain('no_resource_of_required_type');
  });

  it('rejects when no vehicle of the requested class exists', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({ requirements: { vehicleClass: 'sprinter', passengers: 9 } }),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle({ vehicleClass: 'sedan' })],
          drivers: [makeDriver()],
        },
      }),
    );
    expect(reasonsFor(result)).toContain('vehicle_class_unavailable');
  });

  it('rejects when the party cannot be seated', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({ requirements: { vehicleClass: 'sedan', passengers: 6 } }),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle({ vehicleClass: 'sedan', passengerCapacity: 3 })],
          drivers: [makeDriver()],
        },
      }),
    );
    expect(reasonsFor(result)).toContain('vehicle_seats_insufficient');
  });

  it('divides the party across the requested number of vehicles', () => {
    // Six passengers in two SUVs is three each — a 4-seat car is enough.
    const result = couldProviderCover(
      makeContext(),
      makeLine({ quantity: 2, requirements: { vehicleClass: 'suv', passengers: 6 } }),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [
            makeVehicle({ passengerCapacity: 4 }),
            makeVehicle({ passengerCapacity: 4 }),
          ],
          drivers: [makeDriver(), makeDriver()],
        },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('rejects when fewer vehicles are free than requested', () => {
    const busy = makeVehicle({ commitments: [{ interval: window('06:00', '11:00'), quantity: 1 }] });
    const result = couldProviderCover(
      makeContext(),
      makeLine({ quantity: 2, requirements: { vehicleClass: 'suv', passengers: 4 } }),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle(), busy],
          drivers: [makeDriver(), makeDriver()],
        },
      }),
    );
    expect(reasonsFor(result)).toContain('resource_capacity_insufficient');
  });

  it('treats a back-to-back commitment at the boundary as free', () => {
    const handover = makeVehicle({
      commitments: [{ interval: window('04:00', '07:00'), quantity: 1 }],
    });
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        resources: { ...emptyProviderResources, vehicles: [handover], drivers: [makeDriver()] },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('rejects when every vehicle is committed across the window', () => {
    const busy = makeVehicle({ commitments: [{ interval: window('06:00', '11:00'), quantity: 1 }] });
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        resources: { ...emptyProviderResources, vehicles: [busy], drivers: [makeDriver()] },
      }),
    );
    expect(reasonsFor(result)).toContain('resource_schedule_conflict');
  });

  it('rejects a vehicle in maintenance', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle({ status: 'maintenance' })],
          drivers: [makeDriver()],
        },
      }),
    );
    expect(reasonsFor(result)).toContain('no_resource_of_required_type');
  });

  it('rejects a vehicle without a driver — a car alone is not the service', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({ resources: { ...emptyProviderResources, vehicles: [makeVehicle()] } }),
    );
    expect(reasonsFor(result)).toContain('no_driver_available');
  });

  it('rejects when the only driver is off shift for the window', () => {
    // 07:00-10:00Z is 03:00-06:00 local, outside a 06:00-22:00 shift.
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle()],
          drivers: [makeDriver({ schedule: DAYTIME })],
        },
      }),
    );
    expect(reasonsFor(result)).toEqual(
      expect.arrayContaining(['resource_outside_working_hours', 'no_driver_available']),
    );
  });

  it('accepts a driver whose shift crosses midnight and covers the window', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine(),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle()],
          drivers: [makeDriver({ schedule: OVERNIGHT })],
        },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('rejects when a required vehicle feature is missing', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({
        requirements: { vehicleClass: 'suv', passengers: 4, features: ['armored_b6'] },
      }),
      makeCandidate({
        resources: {
          ...emptyProviderResources,
          vehicles: [makeVehicle({ features: ['wifi'] })],
          drivers: [makeDriver()],
        },
      }),
    );
    expect(reasonsFor(result)).toContain('resource_capability_missing');
  });
});

describe('close protection rules', () => {
  const officerLine = (requirements: Record<string, unknown>, quantity = 1) =>
    makeLine({
      serviceCategoryId: 'svc-close-protection',
      serviceCode: 'close_protection',
      assignmentStrategy: 'officer',
      quantity,
      requirements,
    });

  const officerCandidate = (officers: ReturnType<typeof makeOfficer>[]) =>
    makeCandidate({
      coverage: makeCoverage({ serviceCategoryId: 'svc-close-protection' }),
      resources: { ...emptyProviderResources, officers },
    });

  it('accepts when enough certified officers are on shift and free', () => {
    const result = couldProviderCover(
      makeContext(),
      officerLine({ officers: 2, armed: true }, 2),
      officerCandidate([
        makeOfficer({ armedCertified: true }),
        makeOfficer({ armedCertified: true }),
      ]),
    );
    expect(result.eligible).toBe(true);
    expect(result.feasibleResourceIds).toHaveLength(2);
  });

  it('rejects an armed detail when no officer is armed-certified', () => {
    const result = couldProviderCover(
      makeContext(),
      officerLine({ officers: 2, armed: true }, 2),
      officerCandidate([makeOfficer({ armedCertified: false }), makeOfficer({ armedCertified: false })]),
    );
    expect(reasonsFor(result)).toContain('officer_armed_certification_missing');
  });

  it('does not require certification when the detail is unarmed', () => {
    const result = couldProviderCover(
      makeContext(),
      officerLine({ officers: 1, armed: false }),
      officerCandidate([makeOfficer({ armedCertified: false })]),
    );
    expect(result.eligible).toBe(true);
  });

  it('rejects when fewer officers are free than requested', () => {
    const result = couldProviderCover(
      makeContext(),
      officerLine({ officers: 3, armed: false }, 3),
      officerCandidate([makeOfficer(), makeOfficer()]),
    );
    expect(reasonsFor(result)).toContain('officer_count_insufficient');
  });

  it('rejects when a required language is not spoken', () => {
    const result = couldProviderCover(
      makeContext(),
      officerLine({ officers: 1, armed: false, languages: ['de'] }),
      officerCandidate([makeOfficer({ languages: ['en', 'fr'] })]),
    );
    expect(reasonsFor(result)).toContain('resource_capability_missing');
  });

  it('parses a prose language list rather than treating it as one tag', () => {
    const result = couldProviderCover(
      makeContext(),
      officerLine({ officers: 1, armed: false, languages: 'en, fr' }),
      officerCandidate([makeOfficer({ languages: ['en', 'fr'] })]),
    );
    expect(result.eligible).toBe(true);
  });
});

describe('hangar rules', () => {
  const hangarLine = (requirements: Record<string, unknown> = {}) =>
    makeLine({
      serviceCategoryId: HANGAR_SERVICE_ID,
      serviceCode: 'hangar',
      assignmentStrategy: 'hangar_slot',
      requirements,
      serviceWindow: window('18:00', '30:00'),
    });

  const hangarCandidate = (hangars: ReturnType<typeof makeHangar>[]) =>
    makeCandidate({
      coverage: makeCoverage({ serviceCategoryId: HANGAR_SERVICE_ID }),
      resources: { ...emptyProviderResources, hangars },
    });

  it('accepts a bay that comfortably fits the airframe', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: G650ER }),
      hangarLine(),
      hangarCandidate([makeHangar()]),
    );
    expect(result.eligible).toBe(true);
  });

  it('rejects a bay whose door is narrower than the wingspan', () => {
    // The seeded Gateway Bay B: a 72 ft door against a 99.58 ft span.
    const result = couldProviderCover(
      makeContext({ aircraft: G650ER }),
      hangarLine(),
      hangarCandidate([makeHangar({ doorWidthFt: 72 })]),
    );
    expect(reasonsFor(result)).toContain('hangar_aircraft_too_wide');
  });

  it('rejects a bay whose door is shorter than the tail', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: G650ER }),
      hangarLine(),
      hangarCandidate([makeHangar({ doorHeightFt: 22 })]),
    );
    expect(reasonsFor(result)).toContain('hangar_aircraft_too_tall');
  });

  it('rejects a bay whose floor is shorter than the aircraft', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: G650ER }),
      hangarLine(),
      hangarCandidate([makeHangar({ floorLengthFt: 80 })]),
    );
    expect(reasonsFor(result)).toContain('hangar_aircraft_too_long');
  });

  it('rejects a bay rated below the aircraft weight', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: G650ER }),
      hangarLine(),
      hangarCandidate([makeHangar({ maxAircraftWeightLbs: 45_000 })]),
    );
    expect(reasonsFor(result)).toContain('hangar_aircraft_too_heavy');
  });

  it('accepts the same narrow bay for a light jet', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: PC24 }),
      hangarLine(),
      hangarCandidate([
        makeHangar({
          doorWidthFt: 72,
          doorHeightFt: 22,
          floorLengthFt: 80,
          maxAircraftWeightLbs: 45_000,
        }),
      ]),
    );
    expect(result.eligible).toBe(true);
  });

  it('FAILS rather than passes when an aircraft dimension is unknown', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: { ...G650ER, wingspanFt: null } }),
      hangarLine(),
      hangarCandidate([makeHangar()]),
    );
    expect(result.eligible).toBe(false);
    expect(reasonsFor(result)).toContain('hangar_aircraft_dimensions_unknown');
  });

  it('reports a missing aircraft rather than assuming one', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: null }),
      hangarLine(),
      hangarCandidate([makeHangar()]),
    );
    expect(reasonsFor(result)).toContain('aircraft_unknown');
  });

  it('rejects when a heated bay is required and none is heated', () => {
    const result = couldProviderCover(
      makeContext({ aircraft: PC24 }),
      hangarLine({ heated: true }),
      hangarCandidate([makeHangar({ heated: false })]),
    );
    expect(reasonsFor(result)).toContain('hangar_heated_unavailable');
  });
});

describe('an admin-created category with no specific rule', () => {
  it('is eligible on coverage, hours, lead time and capacity alone', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({
        serviceCategoryId: 'svc-de-icing',
        serviceCode: 'de_icing',
        assignmentStrategy: 'generic',
        requirements: { anything: 'the admin declared' },
      }),
      makeCandidate({
        coverage: makeCoverage({ serviceCategoryId: 'svc-de-icing' }),
        resources: emptyProviderResources,
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('is still rejected by the generic gates when they fail', () => {
    const result = couldProviderCover(
      makeContext(),
      makeLine({
        serviceCategoryId: 'svc-de-icing',
        serviceCode: 'de_icing',
        assignmentStrategy: 'generic',
        requirements: {},
      }),
      makeCandidate({
        status: 'pending',
        coverage: makeCoverage({ serviceCategoryId: 'svc-de-icing' }),
        resources: emptyProviderResources,
      }),
    );
    expect(reasonsFor(result)).toContain('provider_not_approved');
  });
});

describe('evaluateAndRank', () => {
  it('separates eligible from rejected and names the deterministic top choice', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [
        makeCandidate({ providerCompanyId: 'p-good', displayName: 'Alpha Transport', rank: 100 }),
        makeCandidate({
          providerCompanyId: 'p-suspended',
          displayName: 'Beta Transport',
          status: 'suspended',
        }),
        makeCandidate({
          providerCompanyId: 'p-wrong-airport',
          displayName: 'Gamma Transport',
          coverage: makeCoverage({ airportId: OTHER_AIRPORT_ID }),
        }),
      ],
    });

    expect(outcome.eligible.map((c) => c.providerCompanyId)).toEqual(['p-good']);
    expect(outcome.rejected.map((c) => c.providerCompanyId).sort()).toEqual([
      'p-suspended',
      'p-wrong-airport',
    ]);
    expect(outcome.top?.providerCompanyId).toBe('p-good');
    expect(outcome.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns a null top when nothing is eligible', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [makeCandidate({ status: 'pending' })],
    });
    expect(outcome.top).toBeNull();
    expect(outcome.eligible).toEqual([]);
  });

  it('handles an empty candidate list without throwing', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [],
    });
    expect(outcome.eligible).toEqual([]);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.top).toBeNull();
  });

  it('never returns an ineligible candidate in the eligible list', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [
        makeCandidate({ providerCompanyId: 'a', status: 'pending' }),
        makeCandidate({ providerCompanyId: 'b', active: false }),
        makeCandidate({ providerCompanyId: 'c' }),
      ],
    });
    for (const candidate of outcome.eligible) {
      expect(candidate.eligible).toBe(true);
      expect(candidate.reasonCodes).toEqual([]);
    }
  });
});

describe('determinism', () => {
  it('produces byte-identical results across repeated evaluations', () => {
    const input = {
      context: makeContext(),
      line: makeLine(),
      candidates: [
        makeCandidate({ providerCompanyId: 'a', displayName: 'Alpha', rank: 300 }),
        makeCandidate({ providerCompanyId: 'b', displayName: 'Bravo', rank: 100 }),
        makeCandidate({ providerCompanyId: 'c', displayName: 'Charlie', rank: 200 }),
      ],
    };

    const first = JSON.stringify(evaluateAndRank(input));
    for (let run = 0; run < 25; run += 1) {
      expect(JSON.stringify(evaluateAndRank(input))).toBe(first);
    }
  });

  it('is unaffected by the order candidates are supplied in', () => {
    const candidates = [
      makeCandidate({ providerCompanyId: 'a', displayName: 'Alpha', rank: 300 }),
      makeCandidate({ providerCompanyId: 'b', displayName: 'Bravo', rank: 100 }),
      makeCandidate({ providerCompanyId: 'c', displayName: 'Charlie', rank: 200 }),
    ];

    const forward = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates,
    });
    const reversed = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [...candidates].reverse(),
    });

    expect(forward.eligible.map((c) => c.providerCompanyId)).toEqual(
      reversed.eligible.map((c) => c.providerCompanyId),
    );
    expect(forward.top?.providerCompanyId).toBe(reversed.top?.providerCompanyId);
  });
});
