# CLAUDE.md — Apron Production

## 0. Mission

Build **Apron Production** as a real, production-ready private-aviation ground-services coordination platform.

This is **not a demo, prototype, proof of concept, static showcase, or fake-data UI**. Core workflows must be backed by the real database, real domain logic, real authorization, real background jobs, and real OpenAI integration with safe fallback behavior.

The product must let a client or operations user describe a trip/request in natural language, convert that request into structured data, deterministically find eligible service providers and concrete resources, use an LLM only where reasoning/judgment is useful, verify every model decision with code, and coordinate fulfillment across the platform.

The visual direction is the supplied Apron reference: calm, premium, modern private aviation, editorial typography, navy/charcoal surfaces, soft warm neutrals, restrained burgundy/crimson action color, generous whitespace, subtle glass/blur only where appropriate, and highly readable operational tables/timelines.

Do not trade correctness for visual polish. Do not trade visual polish for functionality. Both matter.

---

## 1. Product shape

There are **three authenticated operational portals**:

1. **Operations Portal**
   - Internal dispatch/operations team.
   - Creates and manages client requests.
   - Sees passengers, aircraft, flight legs, airports/FBOs, selected providers, resources, maps, timelines, messages, documents, status, exceptions, and decision traces.
   - Can manually intervene, re-match, override with a reason, contact providers, and inspect the AI research pane.
   - This portal owns the operational lifecycle after intake.

2. **Service Provider Portal**
   - For provider-company dispatchers.
   - Sees only requests relevant to their company.
   - Acknowledges or declines individual service lines.
   - Assigns concrete resources such as vehicle + driver, officer, hotel allocation, catering order, fuel uplift, or hangar slot.
   - Manages company profile, service coverage, operating hours, staff/resources, blackout windows, availability, and messages.
   - Client contact details remain hidden until acknowledgement unless Operations explicitly releases them.

3. **Admin Console**
   - Platform governance.
   - Approves/suspends providers.
   - Manages airports, FBOs, service catalogue, provider coverage, rank, platform users, feature flags, system settings, AI configuration metadata, request audit, AI reliability, and health.
   - Can inspect every request and its complete deterministic/AI decision trace.
   - Does not bypass audit logging.

### Client-facing experience

The client-facing request experience is a **minimal external surface**, not a fourth operational console.

It may support:
- guest request by secure link, or
- authenticated client account later.

Client UX should feel like the supplied landing-page reference:
- one primary sentence input;
- AI read-back as editable structured chips/cards;
- clear confirmation;
- request status page;
- no exposure to internal service codes, provider ranking logic, or admin concepts.

If client authentication is implemented, keep it lightweight and isolated from the three operational portals.

---

## 2. Core principle: deterministic execution, AI-assisted reasoning

The LLM is **not** the source of truth for:
- airport identity;
- FBO identity;
- time zones;
- availability;
- capacity;
- business hours;
- overlap math;
- pricing arithmetic;
- provider eligibility;
- resource conflicts;
- state transitions;
- permission checks;
- writes to the database.

The LLM may:
- parse natural-language intent into a strict schema;
- classify ambiguous service needs;
- rank already-eligible choices using supplied business context;
- explain why a choice was made;
- summarize operational status;
- answer read-only research questions from supplied platform data;
- suggest missing information;
- generate internal notes, summaries, emails, and documents when explicitly requested by a user.

Every consequential LLM output must be:
1. schema validated;
2. constrained to IDs/options supplied by code;
3. verified by deterministic code;
4. logged;
5. safely fall back if unavailable or malformed.

The model never directly writes business state.

---

## 3. Required technology

### Application
- Next.js 15+ App Router
- TypeScript strict
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- React Server Components where appropriate
- Server Actions / route handlers for mutations and APIs
- Tailwind CSS v4 with custom design tokens
- accessible headless primitives only where useful
- no default component-library visual style

### Data
- PostgreSQL 16
- Drizzle ORM
- SQL migrations committed to the repository
- Postgres constraints must enforce critical integrity
- pgvector is optional and must not be introduced unless a real retrieval use-case requires it

### AI
- OpenAI Responses API only for the first production implementation
- all model names supplied via environment variables
- structured outputs with Zod
- no hidden fallback to another provider
- no hard-coded API key
- no model call when the required key is absent
- one narrow AI client abstraction so another provider could be added later without rewriting product logic

### Background work
- Redis
- BullMQ or equivalent explicit queue/worker layer
- used for acknowledgement timeout, re-match, notifications, document generation, and non-blocking jobs
- jobs must be idempotent
- retries must be bounded and observable

### Testing
- Vitest
- fast-check for property tests
- integration tests against disposable/local PostgreSQL
- API/route contract tests
- database constraint/concurrency tests
- state-machine tests
- RBAC/tenant-isolation tests
- accessibility checks at component/page-render level where practical
- deterministic scripted AI provider for offline tests/evals

### Explicit testing constraint
Do **not** build a screenshot-based, video-based, visual-regression, or recorded browser E2E suite.

Do not add Playwright/Cypress screenshot baselines, video capture, trace recordings, or CI artifacts whose purpose is visual comparison.

Production readiness must come from:
- deterministic domain tests;
- integration tests;
- database integrity tests;
- API/route contract tests;
- permission tests;
- queue/job tests;
- AI evals;
- security checks;
- build/runtime smoke checks;
- manual product verification during implementation.

A lightweight non-recording smoke command may verify that the built application starts and critical health/API endpoints respond, but it must not become a screenshot/video E2E framework.

### Local runtime
- Docker Compose
- app
- worker
- postgres
- redis
- optional mail capture service for local email testing

### Production target

**One environment.** A single deployed stack, not dev/staging/production tiers. Terraform is
written for that one target; nothing is parameterised across environments it will not have.

- AWS
- ECS Fargate for web and workers
- RDS PostgreSQL
- ElastiCache Redis
- S3 for documents
- CloudFront only if needed for document/static delivery
- Secrets Manager / SSM for secrets
- CloudWatch logs/metrics
- Terraform

**No email delivery.** Amazon SES is deliberately out of scope, and no email is sent from the
deployed environment. Notifications are still produced, recorded and shown — the notification
row, the in-app notifications centre and the request timeline are the delivery channel. The
mail adapter runs with `MAIL_TRANSPORT=log`, which records what would have been sent without
sending it, so the abstraction stays in place for a later decision without an unused SES
identity, verified domain or bounce handling existing in the account meanwhile.

Do not add SES, a verified domain, or any outbound mail infrastructure to the Terraform.

Do not start Terraform/deployment until the local production flow is working end-to-end.

---

## 4. Repository shape

Prefer a structure similar to:

```text
/
  CLAUDE.md
  README.md
  .env.example
  docker-compose.yml

  src/
    app/
      (public)/
      ops/
      provider/
      admin/
      api/

    components/
      ui/
      layout/
      requests/
      timeline/
      maps/
      ai/
      providers/
      resources/

    db/
      schema/
      migrations/
      queries/
      seed/

    domain/
      airports/
      fbos/
      services/
      availability/
      matching/
      requests/
      assignments/
      pricing/
      permissions/
      audit/

    ai/
      client/
      intake/
      matching/
      research/
      summaries/
      evals/

    jobs/
      queues/
      workers/
      handlers/

    auth/
    lib/
      time/
      money/
      validation/
      logging/
      errors/
      config/

  tests/
    unit/
    integration/
    e2e/
    evals/

  infra/
    terraform/
```

The exact folder names may change if there is a strong reason, but maintain strict separation among:
- domain logic;
- persistence;
- AI;
- UI;
- background jobs;
- infrastructure.

---

## 5. RBAC and tenancy

### Roles

Minimum:
- `platform_admin`
- `operations_manager`
- `operations_agent`
- `provider_admin`
- `provider_dispatcher`
- `provider_staff`
- optional `client`

### Permission model

Never authorize solely by route visibility.

Every mutation and sensitive read must perform server-side permission checks.

Examples:
- Admin can manage all companies, airports, FBOs, services, users, and requests.
- Operations can view/manage all operational requests but cannot silently change platform governance data.
- Provider users can access only their own provider company and only request lines offered to that company.
- Provider staff cannot approve their own company.
- A provider cannot see another provider's prices, capacity, staff, vehicles, assignments, or messages.
- Client-facing users can see only their own request.
- Sensitive contact data is released according to request-line state and explicit policy.

### Audit

Every meaningful write records:
- actor;
- role;
- action;
- entity type;
- entity ID;
- before;
- after;
- reason when required;
- timestamp;
- correlation/request ID.

Overrides must require a reason.

---

## 6. Domain model

Do not make `service_category` a hard-coded enum if admins must add new services without a migration.

Use tables/configuration so the initial six services are seed data, not schema limitations.

### Geographic/aviation hierarchy

#### Airport
- `id`
- `icao`
- `iata`
- `name`
- `city`
- `state_region`
- `country_code`
- `latitude`
- `longitude`
- `timezone_iana`
- `active`

ICAO and IATA must be unique where present.

#### FBO
- `id`
- `airport_id`
- `name`
- `phone`
- `email`
- `address`
- `website`
- `latitude`
- `longitude`
- `hours`
- `active`

An airport can have multiple FBOs.

### Service catalogue

#### ServiceCategory
Seed:
- ground transport
- close protection/bodyguard
- hotel
- catering
- fuel
- hangar

Fields:
- `id`
- `code`
- `name`
- `description`
- `unit_label`
- `assignment_strategy`
- `active`
- `config_schema_json`

Adding a new service must be possible from Admin without a migration.

### Provider organization

#### ProviderCompany
- company details
- status: pending / approved / suspended / rejected
- rank
- contacts
- compliance fields
- billing metadata
- active

#### ProviderCoverage
Maps provider + service + airport/FBO/city.

Fields should support:
- airport coverage
- optional FBO-specific coverage
- desk/opening hours
- total capacity
- lead time
- notice restrictions
- blackout windows
- active
- optional price/rate-card reference

`NULL` location never means "everywhere". Use an explicit coverage scope.

### Resources

Model concrete operational resources separately.

#### Vehicle
- provider
- type/class
- make/model
- plate/reference
- passenger capacity
- luggage capacity
- status
- features
- active

#### Driver
- provider
- name
- phone
- licenses/credentials metadata
- status
- working hours
- active

#### SecurityOfficer
- provider
- name
- credentials
- armed/unarmed capability
- schedule
- active

#### HotelInventory / HotelPartner
At minimum support:
- property/provider
- room type
- capacity
- partner/hold rules
- availability windows
- active

#### CateringCapability
- provider
- kitchen/FBO coverage
- lead time
- menu/capability tags
- active

#### FuelCapability
- provider/FBO
- fuel type
- service hours
- uplift capability
- active

#### HangarResource
- provider/FBO
- dimensions/aircraft compatibility
- availability
- active

Do not force every service into an identical concrete-resource schema. Use a shared service-line abstraction with service-specific assignment tables/configuration.

### Aircraft and people

#### Aircraft
- tail number
- type/model
- operator/owner
- dimensions / category fields needed for hangar/FBO logic
- passenger capacity
- notes

#### Client/Organization
- organization
- primary contact
- authorized users

#### Passenger/Crew
Support request-specific manifests/contact data with privacy controls.

### Request

#### Request
- reference
- client/organization
- created_by
- source sentence verbatim
- airport / FBO
- aircraft
- flight number/reference if available
- arrival UTC
- departure UTC
- passenger count
- crew count
- status
- priority
- operational notes
- created/updated timestamps

Request statuses should be a tested state machine, e.g.:
- draft
- awaiting_confirmation
- sent
- sourcing
- partial
- confirmed
- in_progress
- completed
- cancelled
- failed

#### RequestServiceLine
- request
- service category
- quantity
- structured requirements JSON validated by service config
- current provider offer
- current status
- model explanation
- model verified
- SLA/acknowledgement deadline

Line statuses:
- draft
- matching
- offered
- waiting
- acknowledged
- declined
- rematching
- assigned
- in_progress
- completed
- cancelled
- failed

### Offer / Match Attempt

Keep match history, do not overwrite it.

#### ProviderOffer
- request line
- provider
- eligibility snapshot
- rank at time of selection
- reason
- sent_at
- expires_at
- acknowledged/declined/expired timestamps
- status

### Holds and assignments

Distinguish:
- soft candidate calculation;
- offer/market hold if business wants reserved capacity before acknowledgement;
- confirmed concrete assignment.

The supplied specification says nothing is held until acknowledgement. Keep that as the default rule unless changed by explicit business policy.

#### Assignment
- request line
- provider
- service-specific assigned resources
- start UTC
- end UTC
- status

For assignable concrete resources use Postgres exclusion constraints so overlapping assignments cannot double-book the same resource.

Use half-open intervals `[start, end)`.

---

## 7. Time handling

Time bugs are unacceptable.

Rules:
- store instants in UTC using `timestamptz`;
- render in airport/local timezone;
- natural-language intake initially produces local wall time + airport token;
- code resolves airport;
- only after airport resolution may code convert local wall time to UTC;
- DST ambiguity/non-existent local times must force explicit user confirmation;
- recurring provider/resource hours are weekday-based and timezone-aware;
- operating hours that cross midnight must be supported;
- never hand-roll timezone conversion across the codebase;
- one time module owns conversions and overlap helpers.

---

## 8. Intake workflow

Example:
> "Landing at Teterboro Friday at 3am, two cars, three bodyguards, hotel for nine, catering, and fuel."

### Step 1 — LLM extraction

Use OpenAI structured output.

The model returns nullable fields only; it must never invent.

Suggested schema:

```ts
{
  airportToken: string | null,
  fboToken: string | null,
  arrivalLocal: string | null,
  departureLocal: string | null,
  passengers: number | null,
  crew: number | null,
  aircraftToken: string | null,
  services: Array<{
    serviceCode: string | null,
    serviceNameToken: string,
    quantity: number | null,
    requirements: Record<string, unknown>
  }>,
  notes: string | null,
  missingFields: string[],
  ambiguities: Array<{
    field: string,
    issue: string,
    options?: string[]
  }>,
  confidence: "high" | "medium" | "low"
}
```

The model must not output ICAO unless ICAO was explicitly present in user text.

### Step 2 — deterministic resolution

Code resolves:
- airport token → airport IDs;
- optional FBO token → FBO under airport;
- service token → active service category;
- known aircraft → aircraft record if available.

If ambiguous:
- return explicit choices to the user;
- do not guess.

### Step 3 — read-back

Show editable structured chips/cards:
- airport/FBO
- date/time
- passengers/crew
- aircraft
- each service + quantity + service-specific requirements

Nothing is dispatched before confirmation.

### Step 4 — create request

After user confirmation:
- persist request;
- create service lines;
- create audit event;
- enqueue matching.

---

## 9. Eligibility engine: the deterministic oracle

This is the most important code in the project.

Create pure functions with no DB imports, no network, no current clock, no random values.

Inputs are explicit snapshots.

Example concepts:

```ts
couldProviderCover(input): EligibilityResult
couldResourceCover(input): EligibilityResult
rankEligibleProviders(input): RankedCandidate[]
```

Return structured reasons:
- provider not approved;
- service not offered;
- airport/FBO not covered;
- outside desk hours;
- lead time insufficient;
- provider capacity exhausted;
- required resource capability unavailable;
- resource schedule conflict;
- aircraft incompatible with hangar;
- service-specific rule failed;
- excluded due to previous decline;
- etc.

For each service line:
1. load candidate data;
2. convert to immutable input snapshot;
3. evaluate all candidates with pure functions;
4. return eligible and rejected candidates with reason codes;
5. sort eligible candidates deterministically.

Suggested deterministic sort:
1. eligibility;
2. hard business priority/SLA;
3. spare capacity;
4. provider rank;
5. same-provider consolidation bonus;
6. deterministic name/ID tie-break.

The same pure functions are the eval oracle.

Do not duplicate the logic in tests/evals.

---

## 10. LLM matching/reasoning

LLM reasoning is required, but it must sit **after deterministic filtering**.

### Input to model

Give the model only:
- request summary;
- service line;
- eligible candidates only;
- relevant computed facts for each candidate;
- business preferences;
- optional request-wide context about providers already selected for other lines.

Never give it ineligible providers as selectable options.

### Model output

Structured:
```ts
{
  chosenProviderId: string,
  reason: string,
  confidence: "high" | "medium" | "low",
  considerations: string[]
}
```

### Verification

Code checks:
- chosen ID is in eligible list;
- required IDs are valid;
- selected candidate still passes the same eligibility snapshot/version.

If invalid:
- mark AI choice `verified=false`;
- use deterministic top candidate;
- record fallback reason.

### Important

Reasoning may consider:
- greater spare capacity;
- fewer hand-offs / same provider across multiple services;
- stronger platform rank;
- better lead-time margin;
- request-specific preferences that are supplied as structured data.

Reasoning may not:
- invent availability;
- invent cars/drivers;
- infer provider facts absent from data;
- override eligibility;
- change quantities;
- write database state.

---

## 11. Provider acknowledgement and resource assignment

Each request line is independent.

Flow:
1. provider offer created;
2. provider receives realtime/in-app notification and email;
3. provider opens request line;
4. provider can acknowledge or decline;
5. on acknowledge, provider assigns required concrete resources;
6. assignment transaction rechecks conflicts in DB;
7. exclusion constraint prevents double booking;
8. request line becomes assigned/acknowledged;
9. Operations/client status updates;
10. audit event emitted.

If provider declines:
- record decline reason;
- exclude that provider for the current re-match attempt;
- re-run matching for that line only;
- send next offer.

If acknowledgement SLA expires:
- worker marks offer expired;
- line re-matches;
- Operations receives exception notification.

Use optimistic versioning or transactional locking to avoid two users assigning the same resource at once.

---

## 12. Operations Portal

This must be the strongest working area.

### Main dashboard
- today's arrivals/departures
- active requests
- awaiting provider acknowledgement
- exceptions
- services at risk
- completed today
- operational map
- quick create request
- AI research shortcut

### Request list
Filters:
- date
- airport/FBO
- status
- client
- provider
- service
- priority
- assigned/unassigned
- acknowledgement overdue

### Request detail
Must include:
- request header + status
- aircraft
- flight timing
- airport/FBO
- client
- passenger/crew contacts based on permission
- timeline
- services
- provider offers
- concrete assignments
- map
- messages
- documents
- audit history
- AI decision trace
- costs/quotes if implemented
- manual override controls
- research assistant

### Operations research assistant

This is read-only.

It may answer:
- Why was provider A chosen?
- Why was provider B rejected?
- Which FBO serves this arrival?
- What is still unconfirmed?
- If arrival moved by 90 minutes, which services would become unavailable?
- Which provider has the most spare vehicle capacity?
- Which driver is assigned after acknowledgement?

The assistant receives:
- request snapshot;
- relevant airport/FBO inventory;
- complete decision trace;
- current assignments.

Expose narrowly scoped read-only tools such as:
- `simulateRequestChange(...)`
- `getRequestTrace(...)`
- `getAirportServiceInventory(...)`

No tool may mutate state.

If data is missing, answer that the platform does not have it.

---

## 13. Service Provider Portal

### Dashboard
- pending acknowledgements ordered by SLA age
- today's assigned jobs
- upcoming 12/24 hours
- unassigned acknowledged services
- resource conflicts/exceptions

### Request queue
Each item:
- request reference
- airport/FBO
- arrival/departure
- service
- quantity
- aircraft/basic operational details
- time waiting
- acknowledgement deadline
- acknowledge
- can't cover

Before acknowledgement, client direct contact remains hidden by policy.

### Resource scheduling
Use a visual timeline:
- drivers
- vehicles
- officers
- other assignable resources
- working/availability windows
- existing assignments
- selected request interval

### Provider management
- company profile
- covered airports/FBOs
- services
- capacity
- hours
- vehicles
- drivers
- officers
- other resource types
- blackout windows
- provider users
- notification preferences

---

## 14. Admin Console

### Provider approvals
- pending registrations
- submitted documents/status
- service coverage
- review/approve/reject/suspend
- rank
- audit history

### Service catalogue
- CRUD service category
- display name
- units
- requirements schema/config
- assignment strategy
- enable/disable
- no migration to add service

### Airport & FBO registry
- airports
- FBOs
- coordinates
- timezones
- service availability metadata

### Requests
- all requests
- full trace
- provider offers
- overrides
- failures
- audit

### AI observability

Reliability only. Token counts, token pricing and cost estimation are deliberately out of scope for this product (see ADR-015); nothing in the platform computes or stores the monetary cost of a model call.

- calls/day
- stage
- model
- latency
- fallback rate
- schema failure rate
- `verified=false` rate
- intake confidence distribution
- matching validity
- top error reason codes

### Platform
- user management
- RBAC
- feature flags
- notification templates
- SLA defaults
- settings

---

## 15. Search / discovery

The system must support finding:
- airports;
- FBOs;
- providers;
- concrete resources;
- requests;
- clients;
- aircraft.

For v1, database-backed normalized search is preferred over vector search.

Use:
- exact ICAO/IATA matching;
- prefix/fuzzy text matching;
- structured filters;
- optional Postgres trigram indexes.

Do not introduce embeddings merely because AI is present.

---

## 16. Data acquisition strategy

Seed enough realistic data to exercise the product, but do not fake external "live" facts.

Initial seed should include a small but coherent operational network, for example:
- Teterboro (KTEB)
- Newark (KEWR)
- JFK (KJFK)
- Van Nuys (KVNY)
- Miami-Opa Locka (KOPF)
- Palm Beach (KPBI)

Seed:
- multiple FBOs per selected airport where appropriate;
- providers covering overlapping services;
- vehicles and drivers with different schedules;
- officers;
- hotel partners;
- catering;
- fuel;
- hangar capacity;
- a few clients;
- aircraft;
- example requests.

Clearly label seeded demo/reference data in code, but UI should use realistic names and values, never "Provider 1" or "Test Airport".

External aviation/provider datasets are a separate integration phase. Create adapter interfaces now so purchased/licensed data can later replace seed/import data.

---

## 17. Maps

Operations request details should support a map.

Abstract the map provider behind a client component/config.

Map must be useful, not decorative:
- airport/FBO marker
- destination/ground-transport endpoint when available
- provider/resource markers only if data supports them
- route visualization when applicable

No fabricated coordinates.

---

## 18. Messaging and notifications

### In-app
- notifications center
- request/thread messages
- realtime request status updates

### Email
Use a provider abstraction.
For local Docker, route mail to a capture service.

The deployed environment sends **no** email (see "Production target"): the adapter runs with
`MAIL_TRANSPORT=log`. Notification events are still raised, recorded and surfaced in-app —
what changes is the channel, not whether the platform tells anyone.

### SMS
Treat as optional/feature-flagged.
Use for urgent overnight acknowledgement only when configured.

Notification events:
- offer sent
- acknowledgement
- decline
- timeout/escalation
- assignment completed
- operations override
- request confirmed
- request changed/cancelled

Never send duplicate notifications on job retries.

---

## 19. Documents

Support operational documents later without coupling them to core matching.

Examples:
- itinerary
- service confirmation
- handling summary
- provider work order
- client confirmation
- PDF operational packet

Generation may use templates and optional LLM text assistance, but all factual fields come from structured data.

Store generated documents in S3 in production; local filesystem/object-store equivalent for local development.

---

## 20. Pricing and commercial layer

Do not let pricing block core fulfillment, but model it cleanly.

Allow future:
- provider rate cards
- service unit prices
- minimums
- surcharges
- after-hours fees
- platform markup/fee
- quote versions
- currency

All arithmetic is deterministic.

LLM can explain a quote but cannot calculate authoritative totals.

---

## 21. UI design system

The supplied image is the visual north star.

### Visual character
- premium private aviation
- calm
- highly legible
- uncluttered
- understated
- modern
- operationally serious

### Palette
Create semantic tokens, not scattered hex values:
- canvas
- surface
- elevated
- sidebar
- text-primary
- text-secondary
- border
- accent
- accent-strong
- success
- warning
- danger
- info

Suggested feel:
- deep navy/charcoal sidebar
- warm off-white/very light cool gray canvas
- restrained burgundy/crimson CTA
- muted amber for waiting states
- green for approved/confirmed
- pale blue-gray borders

Do not blindly copy colors from the screenshot; derive a coherent token system.

### Typography
- strong editorial serif or premium display face for page/hero headings if licensing allows
- neutral sans-serif for all operational UI
- tabular numerals for times/status metrics

### Components
Create reusable:
- sidebar
- top bar
- page header
- status badge
- stat card
- request card
- request table
- service card
- timeline
- resource scheduler
- command/search field
- AI read-back chip
- AI trace panel
- message thread
- map card
- empty/loading/error states
- confirmation dialogs

### UX rules
- no tiny unreadable text
- no decorative gradients that reduce contrast
- no giant cards for simple metrics
- no layout shift during loading
- skeletons should match final geometry
- sentence case
- buttons state exactly what they do
- dangerous/irreversible actions require confirmation
- keyboard accessible
- WCAG contrast target
- responsive, but optimize authenticated ops screens for desktop first

### Production asset pack

A production asset pack is provided separately as `apron-production-assets/`. Treat it as the canonical visual asset source for the first implementation.

When the pack is present in the repository, copy/preserve it under:

```text
public/assets/apron/
```

Expected structure:

```text
01_brand/
02_service_icons/
03_aviation_icons/
04_ui_domain_icons/
05_backgrounds/
06_service_images/
07_location_placeholders/
08_provider_placeholders/
09_illustrations/
10_misc/
```

Asset rules:
- use `lucide-react` for normal interface icons such as search, settings, calendar, bell, filter, chevrons, edit, close, upload, and download;
- use the custom SVGs in the asset pack for aviation, service, resource, assignment, FBO, provider, and operations-specific concepts;
- do not mix multiple generic icon libraries;
- do not hotlink remote third-party image URLs from UI components;
- use the provided WebP backgrounds/service images for the initial visual implementation;
- retain SVG source assets for crisp rendering and future edits;
- use `next/image` for raster assets where appropriate;
- use SVG icons with `currentColor` so status/theme colors come from design tokens rather than hard-coded image variants;
- create one central typed registry such as `src/lib/assets.ts` instead of scattering literal asset paths through components;
- do not render `10_misc/ui-reference.png` or `asset-pack-preview.png` inside the product; they are implementation references only;
- location imagery in `07_location_placeholders` is deliberately generic and must never be presented as a photograph of a named airport/FBO;
- if a verified real airport/FBO image is unavailable, show the generic fallback plus structured airport information instead of using a false image;
- provider placeholders are fallbacks only; real provider logos should come from the provider/admin media workflow;
- any later third-party photography must have source/license metadata recorded before production use.

Design implementation rules:
- preserve the calm, cool, premium private-aviation feel of the supplied reference;
- use imagery selectively: hero, auth, service cards, and subtle sidebar atmosphere; operational tables/forms should stay clean and primarily data-led;
- never place a large decorative image behind dense operational content if it reduces legibility;
- dark sidebars may use the supplied low-contrast backgrounds at very low visual emphasis;
- Admin should be the most restrained portal visually;
- service-card images must remain consistent in crop, radius, aspect ratio, and treatment;
- implement graceful fallback if an image is missing; broken image icons are not acceptable.

Before building page-specific styling, Claude must inspect:
- `public/assets/apron/README.md`;
- `public/assets/apron/ASSET_MANIFEST.json`;
- `public/assets/apron/DESIGN_TOKENS.css`;
- `public/assets/apron/10_misc/ui-reference.png`.

If the asset pack has not yet been copied into the repository, ask where it is once, document the expected location, and continue building the non-asset-dependent foundation without substituting random internet imagery.

---

## 22. Failure behavior

Every AI path must degrade safely.

### Intake
- OpenAI unavailable → preserve sentence, show structured manual edit UI or retry; do not fabricate parse.
- malformed structured output → Zod rejection, retry within bounded policy, then manual fallback.
- low confidence → ask user to confirm/complete fields.

### Matching
- model unavailable/refuses/times out → deterministic top-ranked eligible candidate.
- invalid provider ID → deterministic fallback and `verified=false`.
- one service line failing must not destroy other lines.

### Research
- model unavailable → show request data/trace without AI summary.
- tool/data gap → explicitly state missing data.
- never claim an action occurred unless represented in database state.

No stale success state beneath an error banner.

---

## 23. OpenAI implementation rules

Environment variables:

```env
OPENAI_API_KEY=
OPENAI_INTAKE_MODEL=
OPENAI_REASONING_MODEL=
OPENAI_RESEARCH_MODEL=
OPENAI_SUMMARY_MODEL=
AI_ENABLED=false
```

`AI_ENABLED` defaults false.

Create one adapter returning:

```ts
{
  data,
  usage: {
    provider: "openai",
    model: string,
    latencyMs: number
  }
}
```

Do not implement token pricing, token accounting or cost estimation anywhere in the codebase.

Persist every production model call:
- stage
- request
- user/actor where relevant
- model
- prompt/template version
- latency
- validation status
- verification status
- error category
- timestamp

Do not store secrets in logs.
Be deliberate before storing raw prompts if they may contain client/PII data; make prompt/body retention configurable.

---

## 24. AI prompt/version discipline

Prompts are code.

Every prompt must:
- live in a versioned source file;
- have a prompt ID/version;
- have tests;
- use structured outputs;
- clearly define allowed information;
- clearly define prohibited behavior;
- separate stable system instructions from volatile request data.

No important prompt may be embedded ad hoc inside a React component.

---

## 25. AI boundary tests

Add source-boundary tests so architecture regressions fail loudly.

For AI decision modules:
- no direct DB mutation imports;
- no `insert/update/delete/upsert/truncate` usage;
- matching model receives eligible candidates, not raw provider registry;
- AI adapter must not import deterministic availability implementation to secretly recompute business logic;
- research assistant has only declared read-only tools;
- exact tool count is asserted where practical;
- AI feature disabled with unset key does not silently call another service.

The production oracle and eval oracle must call the same functions.

---

## 26. Evals

Do not postpone evals until the end of the project.

### Intake eval
At least ~60 cases eventually:
- ICAO provided
- IATA provided
- airport name
- city ambiguity
- missing airport
- relative date
- overnight request
- multiple services
- no quantities
- malformed casual language
- corrections
- ambiguous "car"
- bodyguard/security synonyms
- hotel rooms vs nights
- catering details
- fuel amount missing
- hangar duration

Metrics:
- field accuracy
- airport-token extraction accuracy
- service classification accuracy
- quantity accuracy
- missing-field recall
- hallucination rate
- latency

### Matching eval
Generate known request/register snapshots.

Metrics:
- validity rate: must approach 100%
- agreement with deterministic top rank
- fallback rate
- verified-false rate
- latency

### Research eval
Test:
- answers only from context/tools;
- cites internal decision reason;
- does not invent booking actions;
- says missing data when absent.

Offline test mode must use scripted AI outputs.

---

## 27. Security

Minimum:
- secure password hashing using a modern library
- server-side sessions
- CSRF-safe mutation strategy
- rate limiting
- request validation at every boundary
- secure cookies
- least-privilege RBAC
- secrets only in env/secret store
- no sensitive data in client bundles
- no raw SQL from LLM
- no user prompt executed as code
- no model-generated tool names
- protect file uploads
- MIME/type/size validation
- signed URLs for private documents
- audit log for sensitive access/mutations
- gitleaks in CI
- Trivy image scanning
- dependency scanning

### Seeded accounts

Seeding is how a deployed environment gets its airports, its catalogue and its first
administrator. It is not a local-only convenience.

Every seeded account shares **one** password, so nothing has to be rotated per user. It comes
from `SEED_PASSWORD`, and falls back to the development password when unset.

Seeding a non-local `APP_ENV` is refused **while that fallback is still in use**, because the
development password is published in this repository. Set `SEED_PASSWORD` once for the
deployed environment — from Secrets Manager, never from a file in the repo — and it never
needs changing again.

Do not print a configured `SEED_PASSWORD` to logs. The seed prints the development one only,
and only because it is already public.

---

## 28. Observability

Use structured logging with correlation IDs.

Track:
- request creation
- match attempts
- provider offers
- acknowledgement latency
- rematches/timeouts
- assignment conflicts
- queue failures
- API errors
- AI calls
- AI validation failures
- AI verification fallbacks
- email/SMS sends
- DB latency

Admin/Operations should have meaningful failure visibility, not generic "something went wrong".

---

## 29. State machines

Implement request and line lifecycle through explicit transition functions.

Do not allow arbitrary status assignment.

Example:
```ts
transitionRequest(current, event) -> next
transitionLine(current, event) -> next
```

Unit-test all valid and invalid transitions.

Derived request status should consider all service-line states.

---

## 30. Concurrency and integrity

Critical mutations must be transactional.

Examples:
- provider acknowledgement
- offer expiration
- re-match
- resource assignment
- request cancellation
- manual override

Use:
- unique constraints
- foreign keys
- check constraints
- exclusion constraints for time/resource overlap
- transactional locks/version checks where needed

Do not rely on frontend disabling a button for correctness.

---

## 31. Build phases — complete each before moving on

Claude must work phase-by-phase. Do not scatter partial implementations across the repository.

### Phase 0 — Foundation
Deliver:
- repo skeleton
- Next.js app
- TypeScript strict config
- Tailwind/design tokens
- ingest the provided `apron-production-assets` into `public/assets/apron/` without renaming individual files arbitrarily
- create a typed central asset registry (`src/lib/assets.ts` or equivalent)
- wire Lucide as the single generic UI icon library and use custom pack icons for domain-specific concepts
- Docker Compose
- PostgreSQL
- Redis
- env validation
- lint/typecheck/test baseline
- README
- health route

Exit criteria:
- one command starts local stack;
- app and worker connect to DB/Redis;
- lint/typecheck/tests pass.

### Phase 1 — Schema + migrations + seed
Deliver:
- all core tables
- constraints/indexes
- seed data
- service catalogue
- airports/FBOs/providers/resources/users
- audit table
- AI call table

Exit:
- fresh DB migrates and seeds with one command;
- seed produces realistic end-to-end scenarios.

### Phase 2 — Deterministic availability + scheduling core
Deliver:
- pure eligibility functions
- overlap/time functions
- ranker
- service-specific checks
- exclusion constraints
- property tests

Exit:
- exhaustive/property tests pass;
- no AI involved.

### Phase 3 — Auth + RBAC
Deliver:
- login/logout
- sessions
- role-based layouts/routes
- server-side authorization helpers
- seeded users for all roles

Exit:
- cross-tenant/provider access tests pass.

### Phase 4 — Client/Operations intake
Deliver:
- landing/request composer matching visual direction
- OpenAI structured extraction
- deterministic airport/service resolution
- clarification/read-back UI
- request draft persistence
- AI fallback/manual flow

Exit:
- a sentence can become a valid confirmed request without dummy shortcuts.

### Phase 5 — Matching engine
Deliver:
- candidate load
- pure check
- ranking
- OpenAI choose
- verification
- fallback
- AI usage logging
- match trace persistence

Exit:
- every selected provider is provably eligible;
- model outage still resolves deterministically.

### Phase 6 — Request lifecycle + offers
Deliver:
- state machines
- offer creation
- deadlines
- worker jobs
- rematch on decline/timeout
- notifications events

Exit:
- multi-service request can progress independently per line.

### Phase 7 — Provider Portal
Deliver:
- request queue
- acknowledge/decline
- service/resource management
- 12/24-hour scheduler
- assignment workflow
- concrete conflict enforcement

Exit:
- provider can receive → acknowledge → assign a real resource → complete.

### Phase 8 — Operations Portal
Deliver:
- dashboard
- requests list
- request detail
- timeline
- map
- services
- providers
- assignments
- messages/documents placeholders only if not yet implemented
- manual intervention
- full trace
- AI research assistant

Exit:
- Operations can run the entire request lifecycle.

### Phase 9 — Admin Console
Deliver:
- provider approvals
- service catalogue
- airport/FBO registry
- users/RBAC management
- request oversight
- AI dashboard
- audit explorer
- settings/feature flags

Exit:
- core configuration is manageable without DB edits.

### Phase 10 — Messaging + notifications + documents
Deliver:
- in-app notifications
- realtime status refresh
- email
- optional SMS adapter
- message threads
- operational PDFs/confirmations

### Phase 11 — Evals + hardening
Deliver:
- intake eval suite
- matching eval suite
- research eval suite
- security tests
- accessibility checks
- integration/contract coverage for all critical workflows
- database concurrency/integrity tests
- queue/retry/idempotency tests
- performance checks
- source-boundary tests

Do not add screenshot/video/visual-regression E2E tooling.

### Phase 12 — Local production rehearsal
Deliver:
- full Docker build
- no dev-only dependency assumptions
- restart/retry behavior
- migration/seed docs
- backup/restore notes for local DB
- smoke-test script

Exit:
- clean machine can clone, configure env, run Docker, and execute critical flows.

### Phase 13 — AWS IaC/deployment
Only after local exit criteria pass.

---

## 32. Required production acceptance journeys

These are **product acceptance flows**, not a screenshot/video E2E test suite.

They must be verified through the real local Docker application, supported by unit/integration/contract/database tests for the underlying behavior.

Do not call the build complete until these flows work in the real application.

### Journey A — ground transport
1. Ops/client enters natural-language request.
2. Intake extracts airport/time/2 cars.
3. User confirms read-back.
4. Matching filters providers.
5. AI selects among eligible companies.
6. Verification passes.
7. Provider sees request.
8. Provider acknowledges.
9. Provider assigns two vehicles and two available drivers.
10. DB rejects any conflicting assignment.
11. Ops sees assignments and timeline.
12. Request progresses correctly.

### Journey B — multi-service request
Request:
- ground transport
- close protection
- hotel
- catering
- fuel
- hangar

Each line can select a different provider.
A decline affects only that line.
Overall request becomes partial until all required lines are covered.

### Journey C — timeout
Provider does not acknowledge by SLA.
Worker expires offer and rematches.
No duplicate notifications.
Audit and trace show why.

### Journey D — ambiguous airport
User types "Newark".
System resolves or asks user to choose.
Model never silently assigns an ICAO.

### Journey E — AI down
Disable API key/network.
Intake has safe manual fallback.
Matching uses deterministic top eligible candidate.
Product remains usable.

### Journey F — research
Ops asks why a company was rejected.
Assistant answers from the trace.
Then asks "book them anyway."
Assistant must not perform the action and must state it is read-only.

### Journey G — RBAC attack
Provider A tries direct URL/API access to Provider B data.
Request is denied server-side and logged where appropriate.

---

## 33. Coding rules for Claude Code

- Read this file before each major phase.
- Maintain a `docs/BUILD_STATUS.md` with:
  - current phase
  - completed acceptance criteria
  - commands run
  - test results
  - known issues
  - decisions/questions raised
  - next phase
- Maintain `docs/DECISIONS.md` for architectural decisions.
- Do not mark a phase complete while tests fail.
- Do not use fake implementations to satisfy tests.
- Do not leave core functions as TODOs.
- No `any` unless documented and unavoidable at an external boundary.
- No silent catches.
- Use typed domain errors.
- No random status mutation.
- Every DB query rendered to a UI has deterministic ordering.
- Do not add dependencies without explaining the need in commit/build notes.
- Prefer small, composable modules.
- Keep server-only code server-only.
- Never expose secrets.
- Never hotlink random production imagery or silently replace missing Apron assets with unrelated stock images.
- Never let client code decide authorization.
- Never bypass database constraints because "the UI prevents it".
- Avoid premature microservices. Start as a well-structured modular application + worker.
- Avoid premature vector DB/RAG.
- Avoid premature event-bus complexity.
- Build the simplest architecture that preserves correctness and future extensibility.

### Questions must not block progress

Claude may ask questions whenever a product/business decision is genuinely ambiguous.

However:
- do **not** stop the build waiting for an answer unless continuing would create a security/compliance risk, destroy data, or make the architecture irreversibly wrong;
- write the question and the current assumption in `docs/BUILD_STATUS.md`;
- choose the safest, most reversible production-oriented assumption;
- continue implementing the current and subsequent phases;
- isolate assumptions behind configuration where possible;
- clearly surface all assumptions in the final report.

The expected behavior is: **ask if useful, document the assumption, keep moving**.

---

## 34. Commands and quality gates

Before completing any phase, run the relevant set:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:contracts
npm run build
docker compose build
```

If a script is not needed for a specific phase or the repository uses a different name, document the exact equivalent.

Do not add `test:e2e`, screenshot baselines, video recordings, or visual-regression jobs.

For DB-affecting phases:
- test fresh migration;
- test seed;
- test migration from previous phase state if applicable.

For UI phases:
- manually verify desktop and responsive layout in the running application;
- run non-recording accessibility checks where practical;
- verify empty/loading/error states;
- do not create screenshot baselines, video recordings, or visual-regression suites.

For AI phases:
- test with AI disabled;
- test malformed output;
- test timeout/refusal;
- test schema mismatch;
- test invalid candidate ID;
- test AI call logging (stage, model, latency, validation and verification status).

---

## 35. Definition of done

The product is not done because pages look correct.

A feature is done when:
- UI exists;
- backend exists;
- persistence exists;
- RBAC exists;
- validation exists;
- failure state exists;
- audit/observability exists where relevant;
- tests exist;
- local Docker flow works;
- no dummy behavior is required for the real path.

The entire project is done only when the required production acceptance flows work in the real application and the full local Docker stack passes its quality gates.

A polished UI with mocked actions is not done.
A partially wired backend is not done.
Seed data is allowed for local development, but application behavior may not depend on fake hard-coded responses.

---

## 36. Immediate instruction to Claude Code

Build the project **continuously through all phases** until Apron Production is locally production-ready.

Do not attempt all phases in one uncontrolled code dump. Work sequentially, complete each phase, run its quality gates, update documentation, and then continue automatically into the next phase.

Before coding:
1. inspect the entire repository;
2. identify what already exists and what should be kept/replaced;
3. write the implementation plan for Phase 0 and the high-level roadmap for later phases;
4. create/update `docs/BUILD_STATUS.md`;
5. create/update `docs/DECISIONS.md`;
6. implement Phase 0;
7. run all relevant Phase 0 quality gates;
8. record exact results;
9. immediately continue to Phase 1;
10. repeat this pattern through every phase up to and including the local production rehearsal.

Claude may ask questions along the way, but questions must not become a reason to stop. Unless the issue is destructive, security-critical, compliance-critical, or truly irreversible:
- state the question;
- document the assumption;
- choose the safest reversible default;
- continue building.

Do not wait for phase-by-phase approval.

Do not skip later phases because earlier ones took longer than expected.

Do not silently reduce scope.

Do not leave the project as a demo, mockup, partial prototype, or frontend-only implementation.

The required stopping point is:
- all local production phases completed;
- real database-backed workflows working;
- OpenAI integration and deterministic fallbacks implemented;
- RBAC and tenant isolation enforced;
- provider assignments and database conflict protection working;
- Operations, Provider, and Admin portals complete;
- notifications/jobs implemented;
- AI evals/hardening complete;
- full Docker stack builds and starts cleanly;
- critical production acceptance flows manually verified in the real application;
- all relevant automated tests passing;
- `docs/BUILD_STATUS.md` shows no unresolved blocker that invalidates the product.

AWS deployment remains the final infrastructure phase. If AWS credentials/account-specific values are unavailable, complete the Terraform and deployment documentation as far as possible without inventing credentials, then report exactly what input is required to execute deployment.

The final product should look like a polished private-aviation SaaS, but its strongest quality must be operational correctness.
