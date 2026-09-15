-- ===========================================================================
-- 0002 — identity, tenancy and audit.
--
-- Two tenant axes exist and they are mutually exclusive for a given user:
--   * provider_company_id  — a provider dispatcher sees only their own company;
--   * client_organization_id — a client user sees only their own requests.
-- Platform and operations roles belong to neither and see across both, subject
-- to the server-side permission checks in `src/domain/permissions`.
--
-- The role/tenant pairing is enforced by a CHECK constraint, not by application
-- code, so no code path can create a provider user with no company or an
-- operations user scoped to one (CLAUDE.md §5, §30).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Client organisations
-- ---------------------------------------------------------------------------
create table client_organizations (
  id                    uuid        primary key default gen_random_uuid(),
  name                  text        not null,
  slug                  text        not null,
  primary_contact_name  text,
  primary_contact_email citext,
  primary_contact_phone text,
  billing_email         citext,
  billing_currency      text        not null default 'USD',
  notes                 text        not null default '',
  active                boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint client_organizations_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint client_organizations_currency_format check (billing_currency ~ '^[A-Z]{3}$')
);

create unique index client_organizations_slug_key on client_organizations (slug);
create index client_organizations_name_trgm_idx on client_organizations using gin (name gin_trgm_ops);
create index client_organizations_active_name_idx on client_organizations (active, name, id);

create trigger client_organizations_touch
  before update on client_organizations
  for each row execute function apron_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Provider companies
--
-- `rank` is the platform's own quality ordering, used as a deterministic
-- tie-break in the ranker (CLAUDE.md §9). Lower sorts first.
-- ---------------------------------------------------------------------------
create table provider_companies (
  id                     uuid        primary key default gen_random_uuid(),
  legal_name             text        not null,
  display_name           text        not null,
  slug                   text        not null,
  status                 text        not null default 'pending',
  rank                   integer     not null default 500,
  primary_contact_name   text,
  primary_contact_email  citext,
  primary_contact_phone  text,
  dispatch_email         citext,
  dispatch_phone         text,
  address                text,
  website                text,
  country_code           text,
  insurance_reference    text,
  insurance_expires_at   date,
  license_reference      text,
  billing_email          citext,
  billing_currency       text        not null default 'USD',
  logo_storage_key       text,
  notes                  text        not null default '',
  active                 boolean     not null default true,
  approved_at            timestamptz,
  approved_by_user_id    uuid,
  suspended_at           timestamptz,
  suspension_reason      text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint provider_companies_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint provider_companies_status_known
    check (status in ('pending', 'approved', 'suspended', 'rejected')),
  constraint provider_companies_rank_range check (rank between 1 and 1000),
  constraint provider_companies_currency_format check (billing_currency ~ '^[A-Z]{3}$'),
  constraint provider_companies_country_format
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  -- An approved company must record when and by whom; a suspended one must
  -- record why. Governance state cannot be set without its justification.
  constraint provider_companies_approval_recorded
    check (status <> 'approved' or approved_at is not null),
  constraint provider_companies_suspension_recorded
    check (status <> 'suspended' or (suspended_at is not null and suspension_reason is not null))
);

create unique index provider_companies_slug_key on provider_companies (slug);
create index provider_companies_status_rank_idx on provider_companies (status, rank, display_name, id);
create index provider_companies_name_trgm_idx on provider_companies using gin (display_name gin_trgm_ops);

create trigger provider_companies_touch
  before update on provider_companies
  for each row execute function apron_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create table users (
  id                     uuid        primary key default gen_random_uuid(),
  email                  citext      not null,
  password_hash          text        not null,
  full_name              text        not null,
  phone                  text,
  role                   text        not null,
  provider_company_id    uuid        references provider_companies (id) on delete restrict,
  client_organization_id uuid        references client_organizations (id) on delete restrict,
  status                 text        not null default 'active',
  must_change_password   boolean     not null default false,
  last_login_at          timestamptz,
  failed_login_count     integer     not null default 0,
  locked_until           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint users_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint users_role_known
    check (role in (
      'platform_admin',
      'operations_manager',
      'operations_agent',
      'provider_admin',
      'provider_dispatcher',
      'provider_staff',
      'client'
    )),
  constraint users_status_known check (status in ('active', 'suspended', 'invited')),

  -- Tenancy invariants (CLAUDE.md §5). A provider user is meaningless without a
  -- company; an operations or admin user must not be scoped to one.
  constraint users_provider_tenancy
    check (
      (role in ('provider_admin', 'provider_dispatcher', 'provider_staff'))
        = (provider_company_id is not null)
    ),
  constraint users_client_tenancy
    check ((role = 'client') = (client_organization_id is not null))
);

create unique index users_email_key on users (email);
create index users_role_idx on users (role, full_name, id);
create index users_provider_company_idx on users (provider_company_id, full_name, id)
  where provider_company_id is not null;
create index users_client_organization_idx on users (client_organization_id, full_name, id)
  where client_organization_id is not null;
create index users_name_trgm_idx on users using gin (full_name gin_trgm_ops);

create trigger users_touch
  before update on users
  for each row execute function apron_touch_updated_at();

-- Deferred foreign keys from 0001/earlier in this file now that `users` exists.
alter table platform_settings
  add constraint platform_settings_updated_by_fk
  foreign key (updated_by) references users (id) on delete set null;

alter table feature_flags
  add constraint feature_flags_updated_by_fk
  foreign key (updated_by) references users (id) on delete set null;

alter table provider_companies
  add constraint provider_companies_approved_by_fk
  foreign key (approved_by_user_id) references users (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Sessions
--
-- Opaque random tokens, stored only as a SHA-256 hash, so a database disclosure
-- does not hand over live sessions (ADR-006). Revocation is immediate because
-- there is no self-contained token to keep honouring.
-- ---------------------------------------------------------------------------
create table sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users (id) on delete cascade,
  token_hash   text        not null,
  csrf_secret  text        not null,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  ip_address   inet,
  user_agent   text,

  constraint sessions_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint sessions_expiry_after_creation check (expires_at > created_at)
);

create unique index sessions_token_hash_key on sessions (token_hash);
create index sessions_user_idx on sessions (user_id, created_at desc);
-- Supports the expiry sweep without scanning revoked rows.
create index sessions_live_expiry_idx on sessions (expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Audit
--
-- Every meaningful write lands here with actor, role, before/after and the
-- correlation id that ties it to the HTTP request or job that caused it
-- (CLAUDE.md §5). `reason` is required for the actions that demand one; the
-- constraint enforces it rather than trusting the caller.
-- ---------------------------------------------------------------------------
create table audit_events (
  id              bigint      generated always as identity primary key,
  occurred_at     timestamptz not null default now(),
  actor_user_id   uuid        references users (id) on delete set null,
  actor_role      text,
  actor_label     text        not null default 'system',
  action          text        not null,
  entity_type     text        not null,
  entity_id       text        not null,
  before_state    jsonb,
  after_state     jsonb,
  reason          text,
  correlation_id  text,
  ip_address      inet,

  constraint audit_events_action_format check (action ~ '^[a-z][a-z0-9_.]{2,80}$'),
  -- Overrides and suspensions must carry a reason (CLAUDE.md §5 "Overrides must
  -- require a reason"). Enforced in the database so no service can skip it.
  constraint audit_events_reason_required
    check (
      action not in (
        'request_line.override_provider',
        'request_line.force_status',
        'request.cancel',
        'provider_company.suspend',
        'provider_company.reject',
        'assignment.force_release',
        'user.suspend'
      )
      or (reason is not null and length(btrim(reason)) >= 3)
    )
);

create index audit_events_entity_idx on audit_events (entity_type, entity_id, occurred_at desc);
create index audit_events_actor_idx on audit_events (actor_user_id, occurred_at desc);
create index audit_events_action_idx on audit_events (action, occurred_at desc);
create index audit_events_correlation_idx on audit_events (correlation_id) where correlation_id is not null;
create index audit_events_occurred_idx on audit_events (occurred_at desc, id desc);
