-- ===========================================================================
-- 0006 — the commercial layer.
--
-- Modelled cleanly but kept off the fulfilment critical path (CLAUDE.md §20):
-- a request can be matched, offered, acknowledged and assigned with no rate card
-- present at all. Nothing in the matching engine reads these tables.
--
-- All money is integer minor units plus an ISO-4217 code (ADR-010). There is no
-- numeric/float money column anywhere in this schema; `src/lib/money` owns every
-- arithmetic and rounding operation, and the LLM may explain a quote but never
-- computes one.
-- ===========================================================================

create table rate_cards (
  id                   uuid        primary key default gen_random_uuid(),
  provider_company_id  uuid        not null references provider_companies (id) on delete cascade,
  service_category_id  uuid        not null references service_categories (id) on delete restrict,
  airport_id           uuid        references airports (id) on delete restrict,
  name                 text        not null,
  currency             text        not null default 'USD',
  version              integer     not null default 1,
  effective_from       timestamptz not null default now(),
  effective_to         timestamptz,
  active               boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint rate_cards_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint rate_cards_version_positive check (version > 0),
  constraint rate_cards_effective_ordered
    check (effective_to is null or effective_to > effective_from)
);

create unique index rate_cards_version_key
  on rate_cards (provider_company_id, service_category_id, coalesce(airport_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
create index rate_cards_lookup_idx
  on rate_cards (provider_company_id, service_category_id, active, effective_from desc);

create trigger rate_cards_touch
  before update on rate_cards
  for each row execute function apron_touch_updated_at();

-- A line on a rate card: a unit price, a minimum, a surcharge or a fee. The
-- `kind` selects how `src/domain/pricing` applies it; amounts are minor units.
create table rate_card_items (
  id                  uuid        primary key default gen_random_uuid(),
  rate_card_id        uuid        not null references rate_cards (id) on delete cascade,
  code                text        not null,
  label               text        not null,
  kind                text        not null,
  unit_amount_minor   bigint      not null,
  minimum_amount_minor bigint,
  -- Basis points so a 7.5% markup is exactly 750 and never a float.
  percentage_bps      integer,
  applies_from_minute apron_open_minute,
  applies_to_minute   apron_close_minute,
  sort_order          integer     not null default 100,

  constraint rate_card_items_kind_known
    check (kind in ('unit_price', 'minimum', 'surcharge', 'after_hours_fee', 'platform_fee')),
  constraint rate_card_items_amount_non_negative check (unit_amount_minor >= 0),
  constraint rate_card_items_minimum_non_negative
    check (minimum_amount_minor is null or minimum_amount_minor >= 0),
  constraint rate_card_items_percentage_range
    check (percentage_bps is null or percentage_bps between 0 and 100000),
  -- An after-hours fee is meaningless without the window it applies to.
  constraint rate_card_items_after_hours_window
    check (
      kind <> 'after_hours_fee'
      or (applies_from_minute is not null and applies_to_minute is not null)
    )
);

create unique index rate_card_items_code_key on rate_card_items (rate_card_id, lower(code));
create index rate_card_items_card_idx on rate_card_items (rate_card_id, sort_order, id);

-- ---------------------------------------------------------------------------
-- Quotes. Versioned and immutable once issued: a new version is a new row, so a
-- client confirmation always refers to exactly the figures they were shown.
-- ---------------------------------------------------------------------------
create table quotes (
  id                   uuid        primary key default gen_random_uuid(),
  request_id           uuid        not null references requests (id) on delete cascade,
  version              integer     not null default 1,
  currency             text        not null default 'USD',
  subtotal_minor       bigint      not null default 0,
  platform_fee_minor   bigint      not null default 0,
  total_minor          bigint      not null default 0,
  status               text        not null default 'draft',
  issued_at            timestamptz,
  accepted_at          timestamptz,
  voided_at            timestamptz,
  void_reason          text,
  created_by_user_id   uuid        references users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint quotes_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint quotes_version_positive check (version > 0),
  constraint quotes_status_known check (status in ('draft', 'issued', 'accepted', 'voided')),
  constraint quotes_amounts_non_negative
    check (subtotal_minor >= 0 and platform_fee_minor >= 0 and total_minor >= 0),
  -- The stored total must equal its parts. Enforced in the database so a bad
  -- write cannot present arithmetic that does not add up (CLAUDE.md §20).
  constraint quotes_total_consistent check (total_minor = subtotal_minor + platform_fee_minor),
  constraint quotes_issued_recorded check (status = 'draft' or issued_at is not null),
  constraint quotes_void_reason_required
    check (status <> 'voided' or (void_reason is not null and length(btrim(void_reason)) >= 3))
);

create unique index quotes_version_key on quotes (request_id, version);
create index quotes_request_idx on quotes (request_id, version desc, id);
-- At most one live quote per request.
create unique index quotes_one_issued_per_request
  on quotes (request_id) where status = 'issued';

create trigger quotes_touch
  before update on quotes
  for each row execute function apron_touch_updated_at();

create table quote_lines (
  id                       uuid        primary key default gen_random_uuid(),
  quote_id                 uuid        not null references quotes (id) on delete cascade,
  request_service_line_id  uuid        references request_service_lines (id) on delete set null,
  provider_company_id      uuid        references provider_companies (id) on delete set null,
  rate_card_item_id        uuid        references rate_card_items (id) on delete set null,
  label                    text        not null,
  quantity                 integer     not null default 1,
  unit_amount_minor        bigint      not null,
  amount_minor             bigint      not null,
  sort_order               integer     not null default 100,

  constraint quote_lines_quantity_positive check (quantity > 0),
  constraint quote_lines_amounts_non_negative
    check (unit_amount_minor >= 0 and amount_minor >= 0),
  -- Line arithmetic is checked by the database too: quantity x unit = amount.
  constraint quote_lines_amount_consistent
    check (amount_minor = unit_amount_minor * quantity)
);

create index quote_lines_quote_idx on quote_lines (quote_id, sort_order, id);
create index quote_lines_service_line_idx
  on quote_lines (request_service_line_id) where request_service_line_id is not null;
