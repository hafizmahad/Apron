-- ===========================================================================
-- 0005 — messaging, notifications, documents and AI call records.
--
-- Note on AI records (ADR-015): this table records what is needed to diagnose a
-- failure — stage, prompt version, model, latency, validation and verification
-- outcome. It deliberately has NO token-count and NO cost columns. Token
-- accounting and cost estimation are out of scope for this product.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Message threads
--
-- A thread is scoped to a request and optionally to one provider company. An
-- operations<->provider thread must never be visible to another provider, which
-- `provider_company_id` makes checkable in a single predicate.
-- ---------------------------------------------------------------------------
create table message_threads (
  id                       uuid        primary key default gen_random_uuid(),
  request_id               uuid        not null references requests (id) on delete cascade,
  request_service_line_id  uuid        references request_service_lines (id) on delete cascade,
  provider_company_id      uuid        references provider_companies (id) on delete cascade,
  scope                    text        not null,
  subject                  text        not null default '',
  closed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint message_threads_scope_known
    check (scope in ('internal', 'provider', 'client')),
  -- A provider thread names its provider; internal and client threads must not.
  constraint message_threads_scope_consistent
    check ((scope = 'provider') = (provider_company_id is not null))
);

create index message_threads_request_idx on message_threads (request_id, created_at, id);
create index message_threads_provider_idx
  on message_threads (provider_company_id, updated_at desc, id) where provider_company_id is not null;
create unique index message_threads_provider_line_key
  on message_threads (request_service_line_id, provider_company_id)
  where request_service_line_id is not null and provider_company_id is not null;

create trigger message_threads_touch
  before update on message_threads
  for each row execute function apron_touch_updated_at();

create table messages (
  id             uuid        primary key default gen_random_uuid(),
  thread_id      uuid        not null references message_threads (id) on delete cascade,
  author_user_id uuid        references users (id) on delete set null,
  author_label   text        not null default 'system',
  body           text        not null,
  is_system      boolean     not null default false,
  created_at     timestamptz not null default now(),

  constraint messages_body_present check (length(btrim(body)) > 0)
);

create index messages_thread_idx on messages (thread_id, created_at, id);
create index messages_author_idx on messages (author_user_id, created_at desc) where author_user_id is not null;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table notifications (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references users (id) on delete cascade,
  kind          text        not null,
  title         text        not null,
  body          text        not null default '',
  entity_type   text,
  entity_id     text,
  severity      text        not null default 'info',
  read_at       timestamptz,
  created_at    timestamptz not null default now(),

  constraint notifications_severity_known check (severity in ('info', 'success', 'warning', 'danger')),
  constraint notifications_kind_format check (kind ~ '^[a-z][a-z0-9_.]{2,80}$')
);

create index notifications_user_idx on notifications (user_id, created_at desc, id);
create index notifications_unread_idx on notifications (user_id, created_at desc) where read_at is null;

-- Outbound delivery attempts. The idempotency key is what makes a job retry safe:
-- re-running a handler cannot produce a second email (CLAUDE.md §18).
create table notification_deliveries (
  id               uuid        primary key default gen_random_uuid(),
  idempotency_key  text        not null,
  channel          text        not null,
  recipient        text        not null,
  subject          text,
  body             text        not null default '',
  status           text        not null default 'pending',
  attempts         integer     not null default 0,
  last_error       text,
  sent_at          timestamptz,
  notification_id  uuid        references notifications (id) on delete set null,
  correlation_id   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint notification_deliveries_channel_known check (channel in ('email', 'sms')),
  constraint notification_deliveries_status_known
    check (status in ('pending', 'sent', 'failed', 'suppressed')),
  constraint notification_deliveries_attempts_non_negative check (attempts >= 0),
  constraint notification_deliveries_sent_recorded check (status <> 'sent' or sent_at is not null)
);

create unique index notification_deliveries_idempotency_key
  on notification_deliveries (idempotency_key);
create index notification_deliveries_status_idx
  on notification_deliveries (status, created_at) where status = 'pending';
create index notification_deliveries_recipient_idx
  on notification_deliveries (recipient, created_at desc);

create trigger notification_deliveries_touch
  before update on notification_deliveries
  for each row execute function apron_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create table documents (
  id                       uuid        primary key default gen_random_uuid(),
  request_id               uuid        references requests (id) on delete cascade,
  request_service_line_id  uuid        references request_service_lines (id) on delete cascade,
  provider_company_id      uuid        references provider_companies (id) on delete cascade,
  kind                     text        not null,
  title                    text        not null,
  storage_driver           text        not null default 'filesystem',
  storage_key              text        not null,
  content_type             text        not null,
  byte_size                bigint      not null,
  checksum_sha256          text,
  generated_by_user_id     uuid        references users (id) on delete set null,
  created_at               timestamptz not null default now(),

  constraint documents_kind_known
    check (kind in (
      'itinerary', 'service_confirmation', 'handling_summary',
      'provider_work_order', 'client_confirmation', 'operational_packet', 'upload'
    )),
  constraint documents_driver_known check (storage_driver in ('filesystem', 's3')),
  constraint documents_size_positive check (byte_size > 0),
  constraint documents_checksum_format check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  -- Content type is validated on upload; the constraint stops an arbitrary value
  -- reaching storage and later being served back (CLAUDE.md §27).
  constraint documents_content_type_allowed
    check (content_type in (
      'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
      'text/plain', 'text/csv', 'application/json'
    ))
);

create unique index documents_storage_key_key on documents (storage_driver, storage_key);
create index documents_request_idx on documents (request_id, created_at desc, id) where request_id is not null;
create index documents_provider_idx on documents (provider_company_id, created_at desc, id) where provider_company_id is not null;

-- ---------------------------------------------------------------------------
-- AI call records (ADR-015: reliability only, no tokens, no cost)
-- ---------------------------------------------------------------------------
create table ai_calls (
  id                       bigint      generated always as identity primary key,
  occurred_at              timestamptz not null default now(),

  stage                    text        not null,
  prompt_id                text        not null,
  prompt_version           text        not null,
  provider                 text        not null default 'openai',
  model                    text        not null,

  latency_ms               integer     not null,
  attempt                  integer     not null default 1,

  outcome                  text        not null,
  validation_status        text        not null,
  verification_status      text,
  error_category           text,
  error_detail             text,

  request_id               uuid        references requests (id) on delete set null,
  request_service_line_id  uuid        references request_service_lines (id) on delete set null,
  actor_user_id            uuid        references users (id) on delete set null,
  correlation_id           text,

  -- Retained only when AI_STORE_PROMPT_BODIES is enabled; these may contain
  -- client and passenger data (CLAUDE.md §23).
  prompt_body              text,
  response_body            text,

  constraint ai_calls_stage_known
    check (stage in ('intake', 'matching', 'research', 'summary')),
  constraint ai_calls_outcome_known
    check (outcome in ('success', 'schema_invalid', 'verification_failed', 'timeout', 'refused', 'unavailable', 'error')),
  constraint ai_calls_validation_known
    check (validation_status in ('valid', 'invalid', 'not_applicable')),
  constraint ai_calls_verification_known
    check (verification_status is null or verification_status in ('verified', 'rejected', 'not_applicable')),
  constraint ai_calls_latency_non_negative check (latency_ms >= 0),
  constraint ai_calls_attempt_positive check (attempt > 0),
  -- A non-success outcome must name a category, so the Admin console never has
  -- to show a bare "something went wrong" (CLAUDE.md §28).
  constraint ai_calls_error_categorised
    check (outcome = 'success' or error_category is not null)
);

create index ai_calls_occurred_idx on ai_calls (occurred_at desc, id desc);
create index ai_calls_stage_idx on ai_calls (stage, occurred_at desc, id desc);
create index ai_calls_outcome_idx on ai_calls (outcome, occurred_at desc, id desc);
create index ai_calls_request_idx on ai_calls (request_id, occurred_at desc) where request_id is not null;
create index ai_calls_line_idx on ai_calls (request_service_line_id, occurred_at desc) where request_service_line_id is not null;
create index ai_calls_correlation_idx on ai_calls (correlation_id) where correlation_id is not null;
