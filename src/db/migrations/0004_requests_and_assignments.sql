-- ===========================================================================
-- 0004 — requests, service lines, offers, match traces and assignments.
--
-- The integrity guarantees this file establishes:
--
--  * a service line has at most ONE live offer at a time (partial unique index);
--  * match history is never overwritten — every attempt is an append-only row;
--  * a concretely assignable resource CANNOT be double-booked, enforced by
--    `EXCLUDE USING gist` over `tstzrange(start_utc, end_utc, '[)')`, which is
--    exactly the half-open interval semantics `src/lib/time/interval.ts` uses;
--  * status values are constrained to the state machines in `src/domain/requests`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------
create table requests (
  id                      uuid        primary key default gen_random_uuid(),
  reference               text        not null,
  client_organization_id  uuid        not null references client_organizations (id) on delete restrict,
  created_by_user_id      uuid        references users (id) on delete set null,
  created_via             text        not null default 'ops',

  -- The user's own words, stored verbatim and never rewritten. Intake failure
  -- must still leave the operator with exactly what the client said (§22).
  source_sentence         text        not null default '',

  airport_id              uuid        not null references airports (id) on delete restrict,
  fbo_id                  uuid        references fbos (id) on delete restrict,
  aircraft_id             uuid        references aircraft (id) on delete set null,
  flight_reference        text,

  arrival_utc             timestamptz,
  departure_utc           timestamptz,

  passenger_count         integer     not null default 0,
  crew_count              integer     not null default 0,

  status                  text        not null default 'draft',
  priority                text        not null default 'normal',
  operational_notes       text        not null default '',

  -- Guest requests (no client account). The link token is stored hashed only.
  guest_contact_name      text,
  guest_contact_email     citext,
  guest_contact_phone     text,
  guest_token_hash        text,
  guest_token_expires_at  timestamptz,

  confirmed_at            timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,
  cancellation_reason     text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint requests_reference_format check (reference ~ '^RQ-[A-Z0-9]{4,10}$'),
  constraint requests_created_via_known check (created_via in ('ops', 'client', 'guest')),
  constraint requests_status_known
    check (status in (
      'draft', 'awaiting_confirmation', 'sent', 'sourcing', 'partial',
      'confirmed', 'in_progress', 'completed', 'cancelled', 'failed'
    )),
  constraint requests_priority_known check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint requests_counts_non_negative check (passenger_count >= 0 and crew_count >= 0),
  constraint requests_counts_sane check (passenger_count + crew_count <= 400),
  -- A turnaround must not end before it starts. Either instant may be absent
  -- (an arrival-only or departure-only trip), but if both exist they are ordered.
  constraint requests_window_ordered
    check (arrival_utc is null or departure_utc is null or departure_utc >= arrival_utc),
  constraint requests_has_an_instant
    check (status = 'draft' or arrival_utc is not null or departure_utc is not null),
  constraint requests_fbo_matches_airport_enforced_by_trigger check (true),
  constraint requests_cancellation_reason_required
    check (status <> 'cancelled' or (cancellation_reason is not null and length(btrim(cancellation_reason)) >= 3)),
  constraint requests_guest_contact_present
    check (created_via <> 'guest' or (guest_contact_name is not null and guest_contact_email is not null)),
  constraint requests_guest_token_format
    check (guest_token_hash is null or guest_token_hash ~ '^[0-9a-f]{64}$')
);

create unique index requests_reference_key on requests (reference);
create unique index requests_guest_token_key on requests (guest_token_hash) where guest_token_hash is not null;
create index requests_client_idx on requests (client_organization_id, arrival_utc desc nulls last, id);
create index requests_airport_window_idx on requests (airport_id, arrival_utc, id);
create index requests_status_idx on requests (status, arrival_utc nulls last, id);
create index requests_arrival_idx on requests (arrival_utc, id) where status <> 'cancelled';
create index requests_reference_trgm_idx on requests using gin (reference gin_trgm_ops);

create trigger requests_touch
  before update on requests
  for each row execute function apron_touch_updated_at();

-- An FBO must belong to the request's airport. Expressed as a trigger because a
-- CHECK cannot read another table; enforced in the database regardless, so no
-- service can persist an FBO from a different field.
create or replace function apron_assert_request_fbo_airport()
returns trigger
language plpgsql
as $$
declare
  fbo_airport uuid;
begin
  if new.fbo_id is null then
    return new;
  end if;

  select airport_id into fbo_airport from fbos where id = new.fbo_id;

  if fbo_airport is null then
    raise exception 'FBO % does not exist', new.fbo_id
      using errcode = 'foreign_key_violation';
  end if;

  if fbo_airport <> new.airport_id then
    raise exception 'FBO % belongs to airport %, not %', new.fbo_id, fbo_airport, new.airport_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger requests_fbo_airport_check
  before insert or update of fbo_id, airport_id on requests
  for each row execute function apron_assert_request_fbo_airport();

-- ---------------------------------------------------------------------------
-- Passengers and crew
--
-- Contact details are released according to line state and explicit policy
-- (CLAUDE.md §5); the column exists here, the gating lives in the permission
-- layer and is covered by RBAC tests.
-- ---------------------------------------------------------------------------
create table request_passengers (
  id           uuid        primary key default gen_random_uuid(),
  request_id   uuid        not null references requests (id) on delete cascade,
  full_name    text        not null,
  person_type  text        not null default 'passenger',
  phone        text,
  email        citext,
  notes        text        not null default '',
  is_primary   boolean     not null default false,
  sort_order   integer     not null default 0,
  created_at   timestamptz not null default now(),

  constraint request_passengers_type_known check (person_type in ('passenger', 'crew'))
);

create index request_passengers_request_idx
  on request_passengers (request_id, person_type, sort_order, id);
create unique index request_passengers_single_primary
  on request_passengers (request_id) where is_primary;

-- ---------------------------------------------------------------------------
-- Service lines
--
-- Each line is independent: it has its own status, its own offer, its own SLA
-- and its own assignment. A decline on one line must not disturb another
-- (CLAUDE.md §11, Journey B).
-- ---------------------------------------------------------------------------
create table request_service_lines (
  id                       uuid        primary key default gen_random_uuid(),
  request_id               uuid        not null references requests (id) on delete cascade,
  service_category_id      uuid        not null references service_categories (id) on delete restrict,
  sequence                 integer     not null default 1,
  quantity                 integer     not null default 1,

  -- Validated at runtime against the category's `config_schema_json` (ADR-008).
  requirements_json        jsonb       not null default '{}'::jsonb,

  -- The window the service itself occupies, which is not the same as the flight
  -- window: a hotel spans nights, a hangar spans an overnight, a car meets an
  -- arrival. Resolved during intake from the request window plus the category.
  service_start_utc        timestamptz,
  service_end_utc          timestamptz,

  status                   text        not null default 'draft',

  -- Populated by the matching engine. `model_verified` is false whenever the
  -- model's choice failed code verification and the deterministic top candidate
  -- was used instead (CLAUDE.md §10).
  model_explanation        text,
  model_verified           boolean,
  selection_source         text,

  acknowledgement_deadline_utc timestamptz,
  rematch_count            integer     not null default 0,
  failure_reason           text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint request_service_lines_quantity_positive check (quantity > 0 and quantity <= 500),
  constraint request_service_lines_status_known
    check (status in (
      'draft', 'matching', 'offered', 'waiting', 'acknowledged', 'declined',
      'rematching', 'assigned', 'in_progress', 'completed', 'cancelled', 'failed'
    )),
  constraint request_service_lines_selection_source_known
    check (selection_source is null or selection_source in ('ai', 'deterministic', 'manual')),
  constraint request_service_lines_window_ordered
    check (service_start_utc is null or service_end_utc is null or service_end_utc > service_start_utc),
  constraint request_service_lines_rematch_non_negative check (rematch_count >= 0),
  constraint request_service_lines_failure_reason_required
    check (status <> 'failed' or failure_reason is not null)
);

create unique index request_service_lines_sequence_key
  on request_service_lines (request_id, sequence);
-- One line per service per request; quantity carries "two cars", not two rows.
create unique index request_service_lines_category_key
  on request_service_lines (request_id, service_category_id);
create index request_service_lines_request_idx
  on request_service_lines (request_id, sequence, id);
create index request_service_lines_status_idx
  on request_service_lines (status, acknowledgement_deadline_utc nulls last, id);
create index request_service_lines_deadline_idx
  on request_service_lines (acknowledgement_deadline_utc)
  where status in ('offered', 'waiting');

create trigger request_service_lines_touch
  before update on request_service_lines
  for each row execute function apron_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Provider offers
--
-- Append-only history. An expired or declined offer is never mutated into the
-- next one; a new row is written so the trace survives (CLAUDE.md §6).
-- ---------------------------------------------------------------------------
create table provider_offers (
  id                       uuid        primary key default gen_random_uuid(),
  request_service_line_id  uuid        not null references request_service_lines (id) on delete cascade,
  provider_company_id      uuid        not null references provider_companies (id) on delete restrict,
  attempt_number           integer     not null default 1,
  rank_at_selection        integer     not null,

  -- The exact inputs the engine saw, so an offer can be explained months later
  -- even after coverage or capacity has changed.
  eligibility_snapshot     jsonb       not null default '{}'::jsonb,
  selection_reason         text        not null default '',
  selection_source         text        not null default 'deterministic',

  status                   text        not null default 'sent',
  sent_at                  timestamptz not null default now(),
  expires_at               timestamptz not null,
  acknowledged_at          timestamptz,
  acknowledged_by_user_id  uuid        references users (id) on delete set null,
  declined_at              timestamptz,
  declined_by_user_id      uuid        references users (id) on delete set null,
  decline_reason           text,
  expired_at               timestamptz,
  withdrawn_at             timestamptz,
  withdrawn_reason         text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint provider_offers_status_known
    check (status in ('sent', 'acknowledged', 'declined', 'expired', 'withdrawn')),
  constraint provider_offers_source_known
    check (selection_source in ('ai', 'deterministic', 'manual')),
  constraint provider_offers_expiry_after_send check (expires_at > sent_at),
  constraint provider_offers_attempt_positive check (attempt_number > 0),
  constraint provider_offers_decline_reason_required
    check (status <> 'declined' or (decline_reason is not null and length(btrim(decline_reason)) >= 3)),
  -- Terminal states must record when they happened.
  constraint provider_offers_terminal_timestamps
    check (
      (status <> 'acknowledged' or acknowledged_at is not null) and
      (status <> 'declined'     or declined_at     is not null) and
      (status <> 'expired'      or expired_at      is not null) and
      (status <> 'withdrawn'    or withdrawn_at    is not null)
    )
);

-- At most one live offer per line. This is what makes the waterfall safe under
-- concurrency: an expiry worker and an acknowledging dispatcher cannot both
-- create the next offer.
create unique index provider_offers_one_live_per_line
  on provider_offers (request_service_line_id) where status = 'sent';

create unique index provider_offers_attempt_key
  on provider_offers (request_service_line_id, attempt_number);
create index provider_offers_line_idx
  on provider_offers (request_service_line_id, sent_at desc, id);
create index provider_offers_provider_queue_idx
  on provider_offers (provider_company_id, status, expires_at, id);
-- Drives the SLA sweep.
create index provider_offers_live_expiry_idx
  on provider_offers (expires_at) where status = 'sent';

create trigger provider_offers_touch
  before update on provider_offers
  for each row execute function apron_touch_updated_at();

alter table request_service_lines
  add column current_offer_id uuid references provider_offers (id) on delete set null;

create index request_service_lines_current_offer_idx
  on request_service_lines (current_offer_id) where current_offer_id is not null;

-- ---------------------------------------------------------------------------
-- Match attempts — the decision trace
--
-- One row per evaluation of a line. Holds every candidate considered, eligible
-- and rejected, each with its structured reason codes, plus whether the model
-- was consulted and whether its answer survived verification. This is what the
-- Operations research assistant reads (CLAUDE.md §12) and what Admin inspects.
-- ---------------------------------------------------------------------------
create table match_attempts (
  id                        uuid        primary key default gen_random_uuid(),
  request_service_line_id   uuid        not null references request_service_lines (id) on delete cascade,
  attempt_number            integer     not null,
  engine_version            text        not null,

  evaluated_at              timestamptz not null default now(),
  -- The instant the engine treated as "now"; supplied by the caller, never read
  -- from the clock inside the pure functions (ADR-009).
  evaluation_now_utc        timestamptz not null,

  eligible_candidates       jsonb       not null default '[]'::jsonb,
  rejected_candidates       jsonb       not null default '[]'::jsonb,
  excluded_provider_ids     uuid[]      not null default '{}',

  chosen_provider_id        uuid        references provider_companies (id) on delete set null,
  deterministic_top_id      uuid        references provider_companies (id) on delete set null,

  ai_consulted              boolean     not null default false,
  ai_chosen_provider_id     uuid        references provider_companies (id) on delete set null,
  ai_verified               boolean,
  ai_reason                 text,
  ai_confidence             text,
  fallback_reason           text,

  created_at                timestamptz not null default now(),

  constraint match_attempts_attempt_positive check (attempt_number > 0),
  constraint match_attempts_confidence_known
    check (ai_confidence is null or ai_confidence in ('high', 'medium', 'low')),
  -- If the model was consulted, verification must have produced a verdict.
  constraint match_attempts_verification_recorded
    check (not ai_consulted or ai_verified is not null),
  -- A deterministic fallback must say why it happened.
  constraint match_attempts_fallback_explained
    check (
      not (ai_consulted and ai_verified is false)
      or (fallback_reason is not null and length(btrim(fallback_reason)) > 0)
    )
);

create unique index match_attempts_attempt_key
  on match_attempts (request_service_line_id, attempt_number);
create index match_attempts_line_idx
  on match_attempts (request_service_line_id, attempt_number desc, id);
create index match_attempts_evaluated_idx on match_attempts (evaluated_at desc, id);

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------
create table assignments (
  id                       uuid        primary key default gen_random_uuid(),
  request_service_line_id  uuid        not null references request_service_lines (id) on delete cascade,
  provider_company_id      uuid        not null references provider_companies (id) on delete restrict,
  provider_offer_id        uuid        references provider_offers (id) on delete set null,
  status                   text        not null default 'planned',
  start_utc                timestamptz not null,
  end_utc                  timestamptz not null,
  notes                    text        not null default '',
  created_by_user_id       uuid        references users (id) on delete set null,
  released_at              timestamptz,
  release_reason           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint assignments_status_known
    check (status in ('planned', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  constraint assignments_window_ordered check (end_utc > start_utc),
  constraint assignments_release_reason_required
    check (status <> 'cancelled' or (release_reason is not null and length(btrim(release_reason)) >= 3))
);

create unique index assignments_line_key on assignments (request_service_line_id)
  where status <> 'cancelled';
create index assignments_provider_window_idx
  on assignments (provider_company_id, start_utc, end_utc, id);
create index assignments_line_idx on assignments (request_service_line_id, created_at desc, id);
create index assignments_window_idx on assignments (start_utc, end_utc) where status <> 'cancelled';

create trigger assignments_touch
  before update on assignments
  for each row execute function apron_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Assigned resources — the anti-double-booking table
--
-- One row per concrete resource committed to an assignment. Exactly one of the
-- resource foreign keys is set, chosen by `resource_kind`. Each kind gets its
-- own partial exclusion constraint so two live rows can never overlap in time
-- on the same physical resource.
--
-- `[)` is used deliberately: a driver finishing at 10:00 may start again at
-- 10:00, which matches `overlaps()` in `src/lib/time/interval.ts` exactly.
-- ---------------------------------------------------------------------------
create table assignment_resources (
  id                   uuid        primary key default gen_random_uuid(),
  assignment_id        uuid        not null references assignments (id) on delete cascade,
  resource_kind        text        not null,

  vehicle_id           uuid        references vehicles (id) on delete restrict,
  driver_id            uuid        references drivers (id) on delete restrict,
  officer_id           uuid        references security_officers (id) on delete restrict,
  hotel_room_type_id   uuid        references hotel_room_types (id) on delete restrict,
  catering_capability_id uuid      references catering_capabilities (id) on delete restrict,
  fuel_capability_id   uuid        references fuel_capabilities (id) on delete restrict,
  hangar_resource_id   uuid        references hangar_resources (id) on delete restrict,

  -- Rooms booked, gallons uplifted, covers catered. 1 for singular resources.
  quantity             integer     not null default 1,

  start_utc            timestamptz not null,
  end_utc              timestamptz not null,

  -- Released rows stay for the audit trail but stop blocking the resource.
  released             boolean     not null default false,
  released_at          timestamptz,

  notes                text        not null default '',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint assignment_resources_kind_known
    check (resource_kind in ('vehicle', 'driver', 'officer', 'hotel_room', 'catering', 'fuel', 'hangar')),
  constraint assignment_resources_window_ordered check (end_utc > start_utc),
  constraint assignment_resources_quantity_positive check (quantity > 0),
  constraint assignment_resources_released_recorded
    check (released = false or released_at is not null),

  -- The kind selects exactly one foreign key, and no other may be set.
  constraint assignment_resources_kind_matches_reference
    check (
      case resource_kind
        when 'vehicle'  then vehicle_id is not null
        when 'driver'   then driver_id is not null
        when 'officer'  then officer_id is not null
        when 'hotel_room' then hotel_room_type_id is not null
        when 'catering' then catering_capability_id is not null
        when 'fuel'     then fuel_capability_id is not null
        when 'hangar'   then hangar_resource_id is not null
        else false
      end
      and (case when vehicle_id             is null then 0 else 1 end
         + case when driver_id              is null then 0 else 1 end
         + case when officer_id             is null then 0 else 1 end
         + case when hotel_room_type_id     is null then 0 else 1 end
         + case when catering_capability_id is null then 0 else 1 end
         + case when fuel_capability_id     is null then 0 else 1 end
         + case when hangar_resource_id     is null then 0 else 1 end) = 1
    )
);

-- --- exclusion constraints: the real guarantee (CLAUDE.md §6, §30) ----------
-- A vehicle, a driver, an officer and a hangar bay are singular physical things:
-- two live commitments may never overlap in time.

alter table assignment_resources
  add constraint assignment_resources_vehicle_no_overlap
  exclude using gist (
    vehicle_id with =,
    tstzrange(start_utc, end_utc, '[)') with &&
  ) where (vehicle_id is not null and released = false);

alter table assignment_resources
  add constraint assignment_resources_driver_no_overlap
  exclude using gist (
    driver_id with =,
    tstzrange(start_utc, end_utc, '[)') with &&
  ) where (driver_id is not null and released = false);

alter table assignment_resources
  add constraint assignment_resources_officer_no_overlap
  exclude using gist (
    officer_id with =,
    tstzrange(start_utc, end_utc, '[)') with &&
  ) where (officer_id is not null and released = false);

-- A hangar bay holds `concurrent_aircraft` aircraft; the singular case is the
-- overwhelming majority and is enforced here. Bays with capacity > 1 are modelled
-- as separate rows in `hangar_resources`, so this constraint stays exact.
alter table assignment_resources
  add constraint assignment_resources_hangar_no_overlap
  exclude using gist (
    hangar_resource_id with =,
    tstzrange(start_utc, end_utc, '[)') with &&
  ) where (hangar_resource_id is not null and released = false);

-- Hotel rooms, catering orders and fuel uplifts are *pooled* capacity, not
-- singular objects: several concurrent rows are legitimate up to the pool size.
-- Those limits are checked against `total_rooms`, `max_orders_per_day` and
-- `concurrent_uplifts` inside the assignment transaction, which re-reads the
-- overlapping committed rows under a row lock. No exclusion constraint applies.

create index assignment_resources_assignment_idx
  on assignment_resources (assignment_id, resource_kind, id);
create index assignment_resources_vehicle_idx
  on assignment_resources (vehicle_id, start_utc, end_utc) where vehicle_id is not null and released = false;
create index assignment_resources_driver_idx
  on assignment_resources (driver_id, start_utc, end_utc) where driver_id is not null and released = false;
create index assignment_resources_officer_idx
  on assignment_resources (officer_id, start_utc, end_utc) where officer_id is not null and released = false;
create index assignment_resources_hotel_idx
  on assignment_resources (hotel_room_type_id, start_utc, end_utc) where hotel_room_type_id is not null and released = false;
create index assignment_resources_catering_idx
  on assignment_resources (catering_capability_id, start_utc, end_utc) where catering_capability_id is not null and released = false;
create index assignment_resources_fuel_idx
  on assignment_resources (fuel_capability_id, start_utc, end_utc) where fuel_capability_id is not null and released = false;
create index assignment_resources_hangar_idx
  on assignment_resources (hangar_resource_id, start_utc, end_utc) where hangar_resource_id is not null and released = false;

create trigger assignment_resources_touch
  before update on assignment_resources
  for each row execute function apron_touch_updated_at();
