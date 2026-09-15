-- ===========================================================================
-- 0003 — provider coverage and concrete operational resources.
--
-- The hierarchy the product must answer deterministically:
--
--   airport -> FBO -> service -> provider -> resource -> availability
--
-- and for ground transport specifically:
--
--   airport/FBO -> ground transport provider -> vehicle -> driver -> schedule
--
-- Two rules shape every table here:
--
--  1. A NULL location never means "everywhere" (CLAUDE.md §6). `airport_id` is
--     NOT NULL on every coverage row; FBO-specific coverage sets `fbo_id` and
--     declares scope = 'fbo'. There is no way to express unbounded coverage.
--
--  2. Concrete resources are NOT forced into one shape. A shared coverage and
--     scheduling vocabulary is reused, but vehicles, drivers, officers, hotel
--     room types, catering kitchens, fuel trucks and hangars each keep the
--     columns their own eligibility rule actually needs.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Coverage: which provider offers which service at which airport/FBO.
-- ---------------------------------------------------------------------------
create table provider_coverage (
  id                   uuid        primary key default gen_random_uuid(),
  provider_company_id  uuid        not null references provider_companies (id) on delete cascade,
  service_category_id  uuid        not null references service_categories (id) on delete restrict,
  scope                text        not null default 'airport',
  airport_id           uuid        not null references airports (id) on delete restrict,
  fbo_id               uuid        references fbos (id) on delete restrict,

  -- How many concurrent units of this service the provider can sustain at this
  -- location. The eligibility engine compares this against overlapping
  -- committed assignments, never against a running counter.
  total_capacity       integer     not null default 1,

  -- Minimum notice, measured from "now" to the start of the service window.
  lead_time_minutes    integer     not null default 120,
  -- Furthest ahead a booking is accepted, in days. NULL = no upper bound.
  max_notice_days      integer,

  -- When the *desk* is staffed to accept and coordinate work. Distinct from
  -- whether a driver happens to be free (CLAUDE.md §6 "desk/opening hours").
  is_24_7              boolean     not null default false,

  notes                text        not null default '',
  active               boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint provider_coverage_scope_known check (scope in ('airport', 'fbo')),
  -- scope and fbo_id must agree: FBO scope requires an FBO, airport scope forbids one.
  constraint provider_coverage_scope_consistent
    check ((scope = 'fbo') = (fbo_id is not null)),
  constraint provider_coverage_capacity_positive check (total_capacity > 0),
  constraint provider_coverage_lead_time_sane
    check (lead_time_minutes >= 0 and lead_time_minutes <= 60 * 24 * 30),
  constraint provider_coverage_notice_sane
    check (max_notice_days is null or max_notice_days between 1 and 730)
);

-- One coverage row per provider/service/location. The two partial unique
-- indexes together cover the nullable `fbo_id` without a sentinel value.
create unique index provider_coverage_airport_key
  on provider_coverage (provider_company_id, service_category_id, airport_id)
  where fbo_id is null;

create unique index provider_coverage_fbo_key
  on provider_coverage (provider_company_id, service_category_id, airport_id, fbo_id)
  where fbo_id is not null;

-- The candidate-loading query: "who covers this service at this airport?"
create index provider_coverage_lookup_idx
  on provider_coverage (service_category_id, airport_id, active, provider_company_id);
create index provider_coverage_provider_idx
  on provider_coverage (provider_company_id, service_category_id, airport_id);
create index provider_coverage_fbo_idx on provider_coverage (fbo_id) where fbo_id is not null;

create trigger provider_coverage_touch
  before update on provider_coverage
  for each row execute function apron_touch_updated_at();

-- Desk hours for a coverage row, in the airport's zone.
create table provider_coverage_hours (
  id            uuid                primary key default gen_random_uuid(),
  coverage_id   uuid                not null references provider_coverage (id) on delete cascade,
  weekday       apron_weekday       not null,
  open_minute   apron_open_minute   not null,
  close_minute  apron_close_minute  not null,

  constraint provider_coverage_hours_ordered check (close_minute > open_minute)
);

create index provider_coverage_hours_idx
  on provider_coverage_hours (coverage_id, weekday, open_minute);

-- Blackout windows. Company-wide when `coverage_id` is null, otherwise scoped
-- to one service/location.
create table provider_blackouts (
  id                   uuid        primary key default gen_random_uuid(),
  provider_company_id  uuid        not null references provider_companies (id) on delete cascade,
  coverage_id          uuid        references provider_coverage (id) on delete cascade,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  reason               text        not null default '',
  created_at           timestamptz not null default now(),

  constraint provider_blackouts_ordered check (ends_at > starts_at)
);

create index provider_blackouts_company_idx
  on provider_blackouts (provider_company_id, starts_at, ends_at);
create index provider_blackouts_coverage_idx
  on provider_blackouts (coverage_id, starts_at, ends_at) where coverage_id is not null;

-- ===========================================================================
-- Ground transport: vehicles and drivers
-- ===========================================================================

create table vehicles (
  id                   uuid        primary key default gen_random_uuid(),
  provider_company_id  uuid        not null references provider_companies (id) on delete cascade,
  home_airport_id      uuid        references airports (id) on delete set null,
  vehicle_class        text        not null,
  make                 text        not null,
  model                text        not null,
  model_year           integer,
  plate_reference      text        not null,
  passenger_capacity   integer     not null,
  luggage_capacity     integer     not null default 0,
  features             text[]      not null default '{}',
  status               text        not null default 'available',
  notes                text        not null default '',
  active               boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint vehicles_class_known
    check (vehicle_class in ('sedan', 'suv', 'van', 'sprinter', 'limousine', 'minibus', 'coach', 'armored_suv')),
  constraint vehicles_status_known
    check (status in ('available', 'maintenance', 'retired')),
  constraint vehicles_capacity_positive check (passenger_capacity > 0),
  constraint vehicles_luggage_non_negative check (luggage_capacity >= 0),
  constraint vehicles_year_sane check (model_year is null or model_year between 1980 and 2100)
);

create unique index vehicles_plate_key
  on vehicles (provider_company_id, upper(plate_reference));
create index vehicles_provider_idx
  on vehicles (provider_company_id, active, vehicle_class, plate_reference, id);
create index vehicles_home_airport_idx on vehicles (home_airport_id) where home_airport_id is not null;

create trigger vehicles_touch
  before update on vehicles
  for each row execute function apron_touch_updated_at();

create table drivers (
  id                   uuid        primary key default gen_random_uuid(),
  provider_company_id  uuid        not null references provider_companies (id) on delete cascade,
  home_airport_id      uuid        references airports (id) on delete set null,
  full_name            text        not null,
  phone                text,
  email                citext,
  license_reference    text,
  license_expires_at   date,
  languages            text[]      not null default '{}',
  -- Shifts below are weekday-based wall-clock windows in this zone.
  timezone_iana        text        not null,
  status               text        not null default 'available',
  notes                text        not null default '',
  active               boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint drivers_status_known check (status in ('available', 'off_duty', 'inactive')),
  constraint drivers_timezone_present check (length(timezone_iana) > 0)
);

create index drivers_provider_idx on drivers (provider_company_id, active, full_name, id);
create index drivers_name_trgm_idx on drivers using gin (full_name gin_trgm_ops);

create trigger drivers_touch
  before update on drivers
  for each row execute function apron_touch_updated_at();

create table driver_shifts (
  id            uuid                primary key default gen_random_uuid(),
  driver_id     uuid                not null references drivers (id) on delete cascade,
  weekday       apron_weekday       not null,
  open_minute   apron_open_minute   not null,
  close_minute  apron_close_minute  not null,

  constraint driver_shifts_ordered check (close_minute > open_minute)
);

create index driver_shifts_driver_idx on driver_shifts (driver_id, weekday, open_minute);

-- ===========================================================================
-- Close protection: officers
-- ===========================================================================

create table security_officers (
  id                    uuid        primary key default gen_random_uuid(),
  provider_company_id   uuid        not null references provider_companies (id) on delete cascade,
  home_airport_id       uuid        references airports (id) on delete set null,
  full_name             text        not null,
  phone                 text,
  email                 citext,
  credential_reference  text,
  credential_expires_at date,
  armed_certified       boolean     not null default false,
  languages             text[]      not null default '{}',
  timezone_iana         text        not null,
  status                text        not null default 'available',
  notes                 text        not null default '',
  active                boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint security_officers_status_known check (status in ('available', 'off_duty', 'inactive')),
  constraint security_officers_timezone_present check (length(timezone_iana) > 0)
);

create index security_officers_provider_idx
  on security_officers (provider_company_id, active, full_name, id);
create index security_officers_armed_idx
  on security_officers (provider_company_id, armed_certified) where active;
create index security_officers_name_trgm_idx
  on security_officers using gin (full_name gin_trgm_ops);

create trigger security_officers_touch
  before update on security_officers
  for each row execute function apron_touch_updated_at();

create table officer_shifts (
  id            uuid                primary key default gen_random_uuid(),
  officer_id    uuid                not null references security_officers (id) on delete cascade,
  weekday       apron_weekday       not null,
  open_minute   apron_open_minute   not null,
  close_minute  apron_close_minute  not null,

  constraint officer_shifts_ordered check (close_minute > open_minute)
);

create index officer_shifts_officer_idx on officer_shifts (officer_id, weekday, open_minute);

-- ===========================================================================
-- Hotel
--
-- Availability is derived from committed assignments against `total_rooms`,
-- not from a separately maintained counter — consistent with "nothing is held
-- until acknowledgement" (CLAUDE.md §6) and impossible to drift.
-- ===========================================================================

create table hotel_properties (
  id                    uuid          primary key default gen_random_uuid(),
  provider_company_id   uuid          not null references provider_companies (id) on delete cascade,
  airport_id            uuid          not null references airports (id) on delete restrict,
  name                  text          not null,
  address               text,
  latitude              numeric(9,6),
  longitude             numeric(9,6),
  star_rating           smallint,
  drive_minutes_to_fbo  integer,
  partner_terms         text          not null default '',
  -- Latest local time a room can be held without a guaranteed booking.
  hold_release_minute   apron_open_minute not null default 1080,
  timezone_iana         text          not null,
  active                boolean       not null default true,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint hotel_properties_star_range check (star_rating is null or star_rating between 1 and 5),
  constraint hotel_properties_latitude_range  check (latitude  is null or latitude  between  -90 and  90),
  constraint hotel_properties_longitude_range check (longitude is null or longitude between -180 and 180),
  constraint hotel_properties_coordinates_paired check ((latitude is null) = (longitude is null)),
  constraint hotel_properties_drive_sane
    check (drive_minutes_to_fbo is null or drive_minutes_to_fbo between 0 and 600),
  constraint hotel_properties_timezone_present check (length(timezone_iana) > 0)
);

create unique index hotel_properties_name_key
  on hotel_properties (provider_company_id, airport_id, lower(name));
create index hotel_properties_airport_idx on hotel_properties (airport_id, active, name, id);

create trigger hotel_properties_touch
  before update on hotel_properties
  for each row execute function apron_touch_updated_at();

create table hotel_room_types (
  id                  uuid        primary key default gen_random_uuid(),
  hotel_property_id   uuid        not null references hotel_properties (id) on delete cascade,
  code                text        not null,
  name                text        not null,
  max_occupancy       integer     not null default 2,
  total_rooms         integer     not null,
  active              boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint hotel_room_types_occupancy_positive check (max_occupancy > 0),
  constraint hotel_room_types_total_positive check (total_rooms > 0)
);

create unique index hotel_room_types_code_key on hotel_room_types (hotel_property_id, lower(code));
create index hotel_room_types_property_idx on hotel_room_types (hotel_property_id, active, name, id);

create trigger hotel_room_types_touch
  before update on hotel_room_types
  for each row execute function apron_touch_updated_at();

-- ===========================================================================
-- Catering
-- ===========================================================================

create table catering_capabilities (
  id                    uuid        primary key default gen_random_uuid(),
  provider_company_id   uuid        not null references provider_companies (id) on delete cascade,
  airport_id            uuid        not null references airports (id) on delete restrict,
  fbo_id                uuid        references fbos (id) on delete set null,
  kitchen_name          text        not null,
  lead_time_minutes     integer     not null default 240,
  max_orders_per_day    integer     not null default 6,
  menu_tags             text[]      not null default '{}',
  dietary_tags          text[]      not null default '{}',
  timezone_iana         text        not null,
  active                boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint catering_lead_time_sane check (lead_time_minutes between 0 and 60 * 24 * 14),
  constraint catering_max_orders_positive check (max_orders_per_day > 0),
  constraint catering_timezone_present check (length(timezone_iana) > 0)
);

create unique index catering_capabilities_kitchen_key
  on catering_capabilities (provider_company_id, airport_id, lower(kitchen_name));
create index catering_capabilities_airport_idx
  on catering_capabilities (airport_id, active, kitchen_name, id);

create trigger catering_capabilities_touch
  before update on catering_capabilities
  for each row execute function apron_touch_updated_at();

-- ===========================================================================
-- Fuel
-- ===========================================================================

create table fuel_capabilities (
  id                      uuid        primary key default gen_random_uuid(),
  provider_company_id     uuid        not null references provider_companies (id) on delete cascade,
  airport_id              uuid        not null references airports (id) on delete restrict,
  fbo_id                  uuid        references fbos (id) on delete set null,
  fuel_type               text        not null default 'jet_a',
  truck_reference         text        not null,
  max_uplift_gallons      integer     not null,
  concurrent_uplifts      integer     not null default 1,
  supports_prist          boolean     not null default false,
  timezone_iana           text        not null,
  active                  boolean     not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint fuel_type_known check (fuel_type in ('jet_a', 'jet_a_plus', 'saf_blend', 'avgas_100ll')),
  constraint fuel_max_uplift_positive check (max_uplift_gallons > 0),
  constraint fuel_concurrent_positive check (concurrent_uplifts > 0),
  constraint fuel_timezone_present check (length(timezone_iana) > 0)
);

create unique index fuel_capabilities_truck_key
  on fuel_capabilities (provider_company_id, airport_id, upper(truck_reference));
create index fuel_capabilities_airport_idx
  on fuel_capabilities (airport_id, active, fuel_type, truck_reference, id);

create trigger fuel_capabilities_touch
  before update on fuel_capabilities
  for each row execute function apron_touch_updated_at();

-- ===========================================================================
-- Hangar
--
-- Dimensions are the real constraint. The eligibility rule compares the
-- aircraft's wingspan/length/tail height against the door and floor limits; a
-- missing aircraft dimension makes the check fail, never pass.
-- ===========================================================================

create table hangar_resources (
  id                      uuid          primary key default gen_random_uuid(),
  provider_company_id     uuid          not null references provider_companies (id) on delete cascade,
  airport_id              uuid          not null references airports (id) on delete restrict,
  fbo_id                  uuid          references fbos (id) on delete set null,
  name                    text          not null,
  door_width_ft           numeric(6,2)  not null,
  door_height_ft          numeric(6,2)  not null,
  floor_length_ft         numeric(6,2)  not null,
  floor_width_ft          numeric(6,2)  not null,
  max_aircraft_weight_lbs integer,
  heated                  boolean       not null default false,
  concurrent_aircraft     integer       not null default 1,
  timezone_iana           text          not null,
  active                  boolean       not null default true,
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now(),

  constraint hangar_dimensions_positive
    check (door_width_ft > 0 and door_height_ft > 0 and floor_length_ft > 0 and floor_width_ft > 0),
  constraint hangar_weight_positive
    check (max_aircraft_weight_lbs is null or max_aircraft_weight_lbs > 0),
  constraint hangar_concurrent_positive check (concurrent_aircraft > 0),
  constraint hangar_timezone_present check (length(timezone_iana) > 0)
);

create unique index hangar_resources_name_key
  on hangar_resources (provider_company_id, airport_id, lower(name));
create index hangar_resources_airport_idx
  on hangar_resources (airport_id, active, name, id);

create trigger hangar_resources_touch
  before update on hangar_resources
  for each row execute function apron_touch_updated_at();
