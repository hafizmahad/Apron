# Apron Production — build status

Updated continuously. Phase numbering follows `CLAUDE.md` §31.

---

## Current position

**Phase 12 — local production rehearsal** — complete. **Phase 13 — AWS** is next and needs explicit approval.
Phases 0-11 are complete, plus the click-through wiring and the gaps found in review.

Latest gate run (Phase 11): lint 0 problems · typecheck clean · **413 unit tests** ·
**203 integration tests** · **34 eval assertions** (offline and against live OpenAI) ·
**33/33 RBAC checks** · **340/340 routing checks** (assets, and exactly-one-active-nav).

---

## Environment

| Item | Value |
| --- | --- |
| Compose project | `apron-production` (renamed from `apron` to avoid colliding with an existing project on this machine) |
| PostgreSQL | 16.14, host port **55432** |
| Redis | 7, host port **56379** |
| Mailpit | UI **http://localhost:58025**, SMTP **51025** |
| Web (compose) | host port **53000** |
| Databases | `apron` (development), `apron_test` (integration/contract suites) |
| AI | `AI_ENABLED=true`, key verified against the OpenAI API (136 models visible) |
| Models | intake `gpt-4.1-mini`, reasoning `gpt-4.1`, research `gpt-4.1`, summary `gpt-4.1-mini` |

Non-default ports are deliberate: the machine already runs another Compose project.

---

## Phase 0 — Foundation — **complete**

Delivered:

- Next.js 15.5 App Router, React 19, TypeScript strict with `noUncheckedIndexedAccess`
  and `exactOptionalPropertyTypes`.
- Tailwind v4 two-layer token system (`src/app/globals.css`): the supplied pack palette as
  `--apron-*` primitives, a semantic `@theme` vocabulary on top. No component references a
  raw hex value.
- Asset pack ingested to `public/assets/apron/` (85 files) with a typed registry at
  `src/lib/assets.ts`; `lucide-react` wired as the only generic icon library.
- `src/lib/time/` — the single timezone module. `resolveLocalWallTime` returns
  `ok | ambiguous | nonexistent`; `requireInstant` refuses to coerce either edge case.
- `src/lib/time/interval.ts` — half-open `[start, end)` interval algebra matching the
  Postgres exclusion constraints exactly.
- `src/lib/money/` — integer minor units, no floats.
- `src/lib/config/env.ts` — Zod fail-fast validation; refuses to boot when `AI_ENABLED=true`
  without a key and all four model names.
- `src/lib/logging/` — pino with `AsyncLocalStorage` correlation ids and central redaction.
- `src/lib/errors/` — typed `ApronError` with stable codes mapped to HTTP statuses.
- `src/db/client.ts` — pooled `pg` + Drizzle, transactions, advisory locks.
- `src/db/migrate.ts` — checksummed, transactional SQL migration runner.
- `src/jobs/` — worker entrypoint, Redis connection management, registration seam.
- `/api/health` — real liveness: connects to both dependencies, 503 when degraded.
- `Dockerfile` (multi-stage, `web` and `worker` targets), `docker-compose.yml`.

### Authored brand asset

The supplied `apron-mark.svg` paints its feather in a fixed `#0F2238`, so the mark is
almost invisible on the navy sidebar and the navy app icon. `apron-mark-adaptive.svg` was
authored with identical geometry but `currentColor` feathers, and is what the app shell
renders. The original files are retained and still registered.

---

## Phase 1 — Schema, migrations, seed — **complete**

### Migrations (6 files, all applied)

| File | Contents |
| --- | --- |
| `0001_foundation.sql` | extensions, `updated_at` trigger, weekday/minute domains, platform settings, feature flags, service catalogue, airports, FBOs + hours, aircraft |
| `0002_identity_and_audit.sql` | client organisations, provider companies, users, sessions, audit events |
| `0003_coverage_and_resources.sql` | provider coverage + desk hours + blackouts, vehicles, drivers, officers, shifts, hotels, catering, fuel, hangars |
| `0004_requests_and_assignments.sql` | requests, passengers, service lines, offers, match attempts, assignments, **assignment_resources + 4 exclusion constraints** |
| `0005_messaging_documents_ai.sql` | threads, messages, notifications, deliveries, documents, `ai_calls` |
| `0006_pricing.sql` | rate cards, items, quotes, quote lines |

### Live database objects

```
43 tables   171 indexes   151 check constraints   89 foreign keys   4 exclusion constraints
```

The four exclusion constraints (`vehicle`, `driver`, `officer`, `hangar`) use
`EXCLUDE USING gist (<resource> WITH =, tstzrange(start_utc, end_utc, '[)') WITH &&)`
filtered to live rows. Hotel rooms, catering and fuel are pooled capacity and are checked
under a row lock in the assignment transaction instead — recorded as a decision, not an
omission.

### Seed — reference operational network

`npm run db:seed` is idempotent (verified by running it twice to identical counts) and
refuses any `APP_ENV` other than `local`/`ci`.

```
service_categories  6    provider_companies   17   hotel_properties       4
airports            6    users                21   hotel_room_types       9
fbos               14    provider_coverage    36   catering_capabilities  5
aircraft            6    vehicles             24   fuel_capabilities      8
client_orgs         4    drivers              18   hangar_resources       6
                         security_officers     9
```

Every account signs in with `Apron!Dev2026`.

The network is shaped to exercise matching, not to look tidy:

- three ground-transport companies compete at KTEB, so ranking actually decides;
- Gotham Livery's desk is 08:00–18:00, so a 03:00 arrival filters it out on desk hours;
- Palisade's desk is 16:00–06:00, a window that crosses midnight;
- Blue Sky Provisions needs 12 hours' notice vs Altitude's 4, so short notice filters one out;
- Gateway Bay B has a 72 ft door — a G650ER (99.58 ft span) must be rejected on fit;
- one company is `pending` and one `suspended`, both retaining coverage rows, so eligibility
  must reject them on status alone;
- Sentinel has both armed and unarmed officers, so an armed detail genuinely filters.

### Sourcing honesty

Airports, their identifiers, coordinates, timezones and FBO names are real public reference
facts. **All provider companies, staff, vehicles, hotels, kitchens, fuel trucks and hangars
are fictional** — attributing capacity or availability to a real named business would be
fabricating facts about it. FBO coordinates are deliberately left null rather than invented;
the map uses the real airport reference point (CLAUDE.md §17). Aircraft registrations are
fictional but airframe dimensions are real, because the hangar-fit rule compares against them.

---

## Quality gates — Phase 1

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` (unit) | **pass** — 45 tests, 2 files |
| `npm run test:integration` | **pass** — 37 tests against real PostgreSQL |
| `npm run build` | **pass** — 3 routes compiled |
| `npm run build:worker` | **pass** — worker/migrate/seed bundles |
| `npm run db:migrate` | **pass** — 6 applied, re-run 0 applied / 6 present |
| `npm run db:seed` | **pass** — idempotent across two runs |
| Built app + `/api/health` | **`status: ok`**, database 2 ms, redis 2 ms |

Integration coverage proves, against the real database:

- an overlapping vehicle/driver/officer/hangar commitment is rejected (`23P01`);
- a back-to-back handover at the exact boundary is allowed (half-open semantics);
- releasing a commitment frees the resource;
- under two genuinely concurrent transactions, exactly one commit survives;
- a service line can hold only one live offer;
- a decline without a reason, an override without a reason, and a cancellation without a
  reason are all refused;
- an FBO from a different airport cannot be attached to a request;
- quote totals and line amounts that do not add up are refused.

---

## Decisions and assumptions

Full detail in `docs/DECISIONS.md` (ADR-001 … ADR-015).

| # | Decision |
| --- | --- |
| ADR-015 | **AI cost tracking removed entirely** at the product owner's instruction. `CLAUDE.md` §14/§23/§26/§34 were amended. `ai_calls` has no token or cost columns; the adapter's `usage` is `{ provider, model, latencyMs }`. Reliability telemetry is unaffected. |
| ADR-003 | Status columns are `text` + `CHECK`, not Postgres enums, because `ALTER TYPE … ADD VALUE` cannot run inside the transaction the migration runner uses. |
| ADR-008 | `service_categories` is a table. No code switches on the six codes as an exhaustive set. |
| — | Pooled resources (hotel/catering/fuel) are guarded transactionally, not by exclusion constraints, since concurrent rows up to the pool size are legitimate. |
| — | The seed creates no requests, offers or assignments. Those arrive in Phase 6 through the state machines that own the transitions; writing them here would bypass the very rules the product enforces. |

### Open questions (non-blocking, safest default taken)

1. **Hotel "rooms vs nights vs guests".** "Hotel for nine" is ambiguous. Default: `rooms`
   and `guests` are separate declared fields and intake asks when only a headcount is given.
   Never silently assumes one room per guest.
2. **Guest-link lifetime.** Defaulted to 72 hours, stored as a platform setting so it is
   changeable from Admin without a deploy.
3. **Re-match ceiling.** Defaulted to 4 attempts before a line is marked `failed` for
   operations to resolve; also a platform setting.

---

## Known issues

- The root page is still the Phase 0 shell. The real client composer is Phase 4.
- `registerWorkers()` registers no queues yet and logs that it is idle; queues arrive in
  Phase 6.
- The OpenAI key was pasted into the chat transcript during setup. It works and is stored
  only in `.env` (gitignored), but **it should be rotated** before any non-local use.

---

## Phase 2 — Deterministic availability and scheduling core — **complete**

The most important code in the project (CLAUDE.md §9). Entirely pure: no database import,
no network, no clock, no randomness anywhere under `src/domain/matching/`.

| Module | Contents |
| --- | --- |
| `types.ts` | the immutable snapshot vocabulary — candidates, coverage, resources, context |
| `reasons.ts` | 40 structured rejection reason codes with operations-voice text and a transient/structural classifier |
| `eligibility.ts` | `couldProviderCover` — governance, coverage, timing, capacity |
| `services.ts` | per-strategy concrete-resource rules, registered by `assignment_strategy` |
| `ranking.ts` | integer-only deterministic scoring and a strict total order |

Design points worth stating:

- A candidate accumulates **every** applicable reason rather than short-circuiting, because
  "not approved AND outside desk hours" is more useful to operations than either alone.
- `evaluationNow` is supplied by the caller. The engine never reads the clock, which is what
  makes a stored decision trace reproducible months later.
- An admin-created category falls to the `generic` strategy and is eligible on coverage,
  hours, lead time and capacity — **not** broken (ADR-008).
- Unknown aircraft dimensions make the hangar check **fail**, never pass on a default.
- Ranking is a preference, never a gate: a property test asserts it can never rescue an
  ineligible candidate.
- Scoring is integer arithmetic only, so ordering is not platform-dependent at the margins.
- `isFreeThroughout` uses the same half-open comparison as the Postgres exclusion
  constraint, so the engine and the database can never disagree about what a conflict is.

### Quality gates — Phase 2

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **130 tests**, 5 files |

Unit coverage: 59 eligibility cases, 14 ranker properties (fast-check, 150–300 runs each),
12 architecture-boundary assertions, 45 time/interval tests.

The boundary suite fails the build if the engine ever gains a `Date.now()`, a
`Math.random()`, a drizzle import, a `.insert(`, a raw hex colour in a component, or a
literal `/assets/apron/` path outside the registry.

---

## Phase 3 — Authentication and RBAC — **complete**

| Module | Contents |
| --- | --- |
| `src/auth/password.ts` | argon2id with a scrypt fallback behind one interface; self-describing encodings so a hash keeps verifying after the algorithm changes |
| `src/auth/session.ts` | opaque 256-bit tokens, stored only as SHA-256; per-session CSRF secret; immediate revocation |
| `src/auth/login.ts` | uniform failure for unknown/wrong/suspended, constant work on the unknown-email path, bounded attempts with lockout, transparent rehash |
| `src/auth/context.ts` | `requirePermission`, `assertProviderScope`, `assertClientScope`, `requireCsrf` — all throwing typed errors, all logging denials |
| `src/domain/permissions/` | 38 permissions × 7 roles, exhaustive matrix; tenancy checked separately from capability |
| `src/domain/audit/` | audit rows written inside the caller's transaction; secrets redacted from before/after blobs |
| `src/lib/rate-limit.ts` | Redis fixed-window, fails open **loudly** |
| `src/middleware.ts` | security headers and correlation id — deliberately does NOT authenticate, since it cannot see the session row |

Deliberate policy decisions, asserted by tests:

- Operations **cannot** approve, suspend or rank providers, manage the catalogue, registry,
  users, settings or flags. That is platform governance.
- An operations **agent** cannot cancel, override, force a status, release contacts, or
  create/release assignments; a **manager** can.
- `provider_staff` is read-and-assign only — no acknowledge, no decline, no company admin.
- **No provider role holds `provider.approve` at all**, and `canApproveProvider` additionally
  refuses any actor whose own company is the subject.
- Operations must **not** acknowledge on a provider's behalf — that would record a
  commitment the provider never made.
- Passenger contacts are concealed from a provider until *their own* line is acknowledged
  or operations releases them explicitly. Another provider's acknowledgement does not
  reveal them.

---

## Phase 4 — Intake — **complete**

Delivered so far:

| Module | Contents |
| --- | --- |
| `src/ai/client/` | the one narrow adapter (ADR-007): OpenAI implementation, deterministic scripted implementation, and the entry point that records every call in `ai_calls` |
| `src/ai/intake/` | the versioned extraction prompt (`intake.extract` v1.0.0) and its nullable-everything schema |
| `src/domain/airports/resolve.ts` | ICAO/IATA → exact name/city → pg_trgm similarity, returning CANDIDATES rather than a guess |
| `src/domain/services/resolve.ts` | live-catalogue resolution with a synonym table that works with AI switched off |
| `src/domain/services/requirements.ts` | compiles a category's declared fields into a Zod schema at request time (ADR-008) |
| `src/domain/requests/intake.ts` | the pipeline: extract → resolve → convert local time → surface questions |
| `/client` | the composer, hero and structured read-back |

The ordering rule is enforced by construction: the model returns **tokens**, code resolves
them, and a local wall time is converted to an instant **only after** the airport (and
therefore its zone) is known. A DST-ambiguous or non-existent local time becomes an
explicit question, never a silent coercion.

With AI unavailable the pipeline still runs — the sentence is preserved verbatim, a
deterministic keyword pass produces what it honestly can, and the UI says why.

Both items left open when this section was first written are now closed, and were
re-verified against the running build rather than assumed:

- **The confirmed draft persists and dispatches.** `src/app/client/confirm.ts` calls
  `createRequest(...)` and then `startMatchingForRequest(...)`, so confirming a read-back
  creates the request, its service lines and its audit event, and starts the offer waterfall.
- **The eval suite exists.** `tests/evals/` holds intake (15), matching (11) and research (8)
  cases, scored by `scoring.ts` against the same deterministic oracle production uses.

---

## Portal surfaces built

Every navigation destination now resolves. Twelve are **real pages reading live data**;
the rest are honest placeholders naming the phase that builds them — not fake screens.

**Real now:** Admin overview · provider approvals · service catalogue · airport & FBO
registry · users & roles · settings & flags · audit explorer · AI reliability · Operations
providers & coverage · Operations airports · Provider resources · Provider coverage &
hours · Provider team · Client composer.

**Placeholders (workflow not built yet):** Operations requests, schedule, exceptions,
research, messages · Admin request oversight · Provider queue, schedule, messages.

---

## Quality gates — Phases 3 and 4

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **295 tests**, 7 files |
| `npm run test:integration` | **pass** — **65 tests** against real PostgreSQL |
| `npm run build` | **pass** — 25 routes |
| `npm run verify:rbac` | **33/33** against the running build |
| `npm run verify:routing` | **152/152** — every one of the 21 seeded accounts |

`verify:routing` signs in **every** seeded account with its real password and asserts: the
password works, `/` redirects to that role's own portal, that portal renders, every other
portal is refused *back to their own portal* (never to sign-in, which would wrongly imply
a dead session), and every link in the rendered navigation resolves.

---

## Bugs these gates caught

1. **Vitest pool setting was a no-op.** The default pool is `forks`; a `threads` option
   did nothing, so integration files raced on one database — deadlocks and vanishing
   foreign keys. Fixed with `pool: 'forks'`, `singleFork: true`.
2. **Three schema columns mapped to the wrong name.** `occurredAt`/`evaluatedAt` were
   emitting `created_at`. Every audit and match-trace query would have failed.
3. **Health check hid its own cause.** It reported only "not reachable"; now it carries the
   driver's message — and immediately revealed that `silent` was missing from the
   `LOG_LEVEL` enum.
4. **Correlated subqueries silently bound to the wrong table.** Drizzle renders
   `${airports.id}` inside a `sql` template as a bare `"id"`, which Postgres resolves
   against the *inner* scope. One page failed loudly with SQLSTATE 42702; several others
   were returning **silently wrong counts**. Fixed by `qualified()` in `src/db/sql.ts` and
   applied to all 14 correlated references.
5. **A permission refusal rendered as a raw 500.** There was no error boundary, so an
   ordinary role difference looked like a server fault. Added `error.tsx` and `not-found.tsx`,
   and corrected the provider messages page to require a *view* permission rather than a
   *send* one.
6. **`/client` did not exist.** `homePortal()` routed client accounts to a 404. The client
   surface now exists and all four client accounts land on it.

---

## Known issues

- The OpenAI key was pasted into the chat transcript during setup. It works and lives only
  in gitignored `.env`, but **it should be rotated** before any non-local use.
- On Windows, `next build` hangs if the standalone server is running — it holds `.next`
  open. Stop the server before building.

---

## Phase 5 — Matching engine wired end to end — **complete**

| Module | Role |
| --- | --- |
| `src/db/queries/matching-snapshot.ts` | loads the database into the immutable snapshot the pure engine consumes — including providers that will be rejected, so the trace can explain them |
| `src/ai/matching/prompt.ts` | `matching.select` v1.0.0 — sees only already-eligible candidates and the figures it may weigh |
| `src/services/matching.ts` | orchestration: evaluate → consult → **verify** → record |

The order is the guarantee. The deterministic answer is computed **before** the model is
consulted, so it always exists. The model is then asked only when there is a genuine choice
(two or more eligible candidates), and its answer is checked in code against the same
snapshot. An answer that does not survive is discarded.

`verifySelection` is proven **total** by a 1000-run property test: for any string a model
could emit, it either returns a genuinely eligible candidate or refuses with a reason.
There is no third outcome, and a refusal always leaves a usable deterministic fallback.

---

## Phase 6 — Request lifecycle, offers and workers — **complete**

| Module | Role |
| --- | --- |
| `src/domain/requests/state-machine.ts` | pure request and line lifecycles; request status **derived** from its lines |
| `src/domain/requests/create.ts` | transactional request creation with per-service window derivation |
| `src/services/offers.ts` | dispatch, acknowledge, decline, expire, re-match |
| `src/jobs/queues/definitions.ts` | three queues, bounded retries, idempotency keys |
| `src/jobs/workers/register.ts` | SLA worker, matching worker, and a periodic safety-net sweep |

Every offer mutation runs inside a transaction guarded by a **Postgres advisory lock** keyed
on the service line. That is what makes the waterfall safe under concurrency: the SLA worker
expiring an offer and a dispatcher acknowledging it can arrive in the same millisecond, and
exactly one wins.

The **sweep** is why the SLA is a guarantee rather than a hope — nothing depends on a single
delayed Redis message surviving a restart or a deploy.

---

## Quality gates — Phases 5 and 6

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **342 tests**, 9 files |
| `npm run test:integration` | **pass** — **107 tests** against real PostgreSQL |
| `npm run worker` | **boots**, both queues registered |

Integration coverage now proves, against the real seeded network:

- a 03:00 arrival at Teterboro rejects the daytime-only desk on `outside_desk_hours`;
- an unapproved company is never eligible, and a suspended one is rejected on status;
- a declined provider is excluded from the next attempt automatically;
- a decline on one line leaves the other line's offer untouched (Journey B);
- an expired offer re-matches to a **different** provider (Journey C);
- expiring twice produces one expiry and one counter increment (idempotency);
- an offer already acknowledged is never expired by a late job;
- the sweep catches an offer no delayed job handled;
- the waterfall stops at the re-match ceiling and fails the line for operations;
- a provider from another company cannot acknowledge an offer (Journey G);
- the request derives `partial` then `confirmed` as its lines are covered;
- with the model timing out, returning prose, or naming a provider that was never offered,
  the selected provider is still provably eligible (Journey E).

---

## Bugs these gates caught

7. **The sweep judged expiry against the wall clock, not the instant it swept for.**
   `handleExpireOffer` called `new Date()` internally while the sweep passed its own `now`,
   so the two disagreed and nothing expired. The instant is now a parameter.
8. **A hallucinated provider id crashed the whole match.** `ai_chosen_provider_id` is a
   foreign key, so an invented id raised a constraint violation — taking down the very
   fallback that exists to survive it. Only ids naming a real candidate are stored now; the
   raw value is preserved in `fallbackReason`.
9. **BullMQ rejects `:` in custom job ids** (it namespaces its Redis keys with colons).
   Job ids now use `-`.
10. **The derived request status understated reality.** A request with one service already
    delivered and another merely assigned reported `confirmed`; it now reports `in_progress`.

## A correct behaviour worth naming

An 03:00 arrival with an eight-hour close-protection detail **fails to match**, and that is
right: Sentinel's Teterboro officers work 18:00–06:00, so no single officer covers
03:00–11:00. The platform says nobody can do it end to end rather than silently arranging a
hand-off the client never agreed to. There is an explicit test for both halves of this — the
failure at 03:00, and a successful match for the same detail inside the night shift.

---

## Next

Phase 7 (provider acknowledge/assign UI), Phase 8 (operations dashboard, timeline, request
detail, research assistant), Phase 9 (admin actions), Phase 10 (notifications and documents).
The services behind Phases 7 and 8 are already built and tested — what remains is the UI on
top of them.


---

## Phase 7 — Provider Portal — **complete**

| Surface | What it does |
| --- | --- |
| `/provider` | pending acknowledgements ordered by SLA age, today's jobs, the next 12/24 hours, acknowledged-but-unassigned work |
| `/provider/queue` | every live offer with its deadline, acknowledge and "can't cover" with a mandatory reason |
| `/provider/schedule` | the resource timeline — drivers, vehicles, officers — with working windows, existing commitments and the requested interval overlaid |
| `/provider/resources` | vehicles, drivers, officers, hotel, catering, fuel and hangar capability |
| `/provider/coverage` | covered airports and FBOs, desk hours, capacity, lead time, blackout windows |
| `/provider/team` | the company's own users |

Every query in `src/db/queries/provider-queue.ts` takes `providerCompanyId` as its **first**
parameter and filters on it. That is not a convention — it is what makes Journey G a property
visible at every call site rather than something to remember.

Client contact details are withheld until acknowledgement, unless Operations has explicitly
released them (see Phase 9 below).

---

## Phase 8 — Operations Portal — **complete**

| Surface | What it does |
| --- | --- |
| `/ops` | today's arrivals and departures, active requests, awaiting acknowledgement, exceptions, services at risk, completed today |
| `/ops/requests` | the full list with URL-driven filters: date, airport, status, client, provider, service, priority, assignment state, acknowledgement overdue |
| `/ops/requests/[id]` | header, aircraft, timing, airport/FBO, client, passengers by permission, every service line with its offers, committed resources, map, audit history, decision trace and the research assistant |
| `/ops/schedule` | the operational day |
| `/ops/exceptions` | failures, overdue acknowledgements and at-risk services |
| `/ops/providers`, `/ops/airports` | the operational registers |
| `/ops/research` | the read-only assistant |

The decision trace shows, per attempt: which candidates were considered, the reason code for
every rejection, the deterministic ranking, what the model chose, and whether verification
passed. A `verified=false` is displayed as such rather than hidden.

**Journey F verified against the live OpenAI key:** asked why a company was rejected, the
assistant answered from the trace; asked to "book them anyway", it refused and stated it is
read-only (`actionRequested: true`, refusal text correct). Five `research` calls recorded in
`ai_calls`.

---

## Phase 9 — Admin Console and Operations interventions — **complete**

### Governance (`src/services/governance.ts`)

Approve · suspend · reject · rank providers · create and toggle service categories · create
airports and FBOs · create users · suspend users · platform settings · feature flags.

Every one writes its audit event **in the same transaction** as the change, carrying the
before and after state and — where the action demands it — the reason.

Two of these do more than set a column, and both are tested:

- **Suspending a provider withdraws every live offer it holds** and returns those lines to
  matching. Without this a company could acknowledge work minutes after being suspended.
  Coverage rows are kept: suspension is a status, not a deletion.
- **Suspending a user revokes every live session immediately**, rather than letting access
  run until the token expires. The action reports how many sessions it ended.

### Operations interventions (`src/services/interventions.ts`)

Override the provider choice · cancel a request · retry a failed line · release passenger
contacts early. Each requires a written reason; each is refused without one.

The override is the interesting one. It does **not** write an assignment — it sends a real
offer, with a real acknowledgement deadline, through the same machinery, taking the same
advisory lock (namespace 4201) as an automatic dispatch. What is overridden is the *choice*,
not the process, so the chosen provider may still decline. Approval and coverage are enforced
even here: a suspended company, or one that does not cover that service at that airport, is
refused however Operations asks.

### Where the controls live

| Page | Controls |
| --- | --- |
| `/admin/providers` | approve, reject with reason, rank, suspend with reason, reinstate |
| `/admin/catalogue` | add a service category, enable/disable one |
| `/admin/registry` | add an airport, add a handler |
| `/admin/users` | create an account, suspend with reason, reactivate |
| `/admin/settings` | edit any setting (JSON-validated), flip any feature flag |
| `/ops/requests/[id]` | override provider, retry a failed line, release contacts, cancel the request |

`hasPermission()` decides whether a control is **drawn**; the server action re-checks the
same permission and refuses regardless. Visibility is courtesy, refusal is the guarantee
(CLAUDE.md §5).

The override control offers only approved companies that actually cover that service at that
airport — the same set the server enforces. A company that already declined the line is still
listed but labelled "already refused this line", because Operations may have spoken to them
since; the choice is theirs to make knowingly.

---

## Quality gates — Phases 7, 8 and 9

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **342 tests** |
| `npm run test:integration` | **pass** — **153 tests** against real PostgreSQL |
| `npm run verify:rbac` | **33/33** |
| `npm run verify:routing` | **194/194** — every seeded account signs in, lands on its own portal, is bounced out of the other three, and every navigation link resolves |

Phase 9 integration coverage proves, against the real seeded network:

- a suspension withdraws the live offer and returns the line to matching;
- a suspension keeps coverage rows and ends live sessions at once;
- a category created through the console takes a request line immediately — no migration;
- an unknown IANA timezone is refused before it can corrupt every arrival time at that field;
- coordinates are stored exactly as entered, with no floating-point drift;
- a created account's password verifies, and never appears in the audit trail;
- an override withdraws the old offer, sends a real one, and the new provider may decline;
- an override is refused for a non-covering or suspended provider, and without a reason;
- a contacts release reaches exactly one provider on exactly one line;
- cancelling releases every committed vehicle, driver and officer, and is idempotent.

---

## Bugs these gates caught (Phases 7-9)

11. **A transaction aborted by a constraint violation could not then be queried** for the
    conflicting window. The insert is now wrapped in a SAVEPOINT, so the violation is caught
    without poisoning the enclosing transaction.
12. **Correlated subqueries bound to the wrong table.** Drizzle renders `${airports.id}`
    inside a `sql` template as a bare `"id"`, which Postgres binds to the *inner* table. One
    page raised 42702; others returned **silently wrong counts**. `qualified()` in
    `src/db/sql.ts` now emits `table.column`, and all 14 correlated references use it.
13. **A permission refusal rendered as a raw 500.** Added `error.tsx` and `not-found.tsx`,
    and corrected `/provider/messages` to require a *view* permission, not a *send* one.
14. **Raw SQL expressions returned strings, not Dates.** `sql<Date>` was a lie;
    `/ops/requests` threw on `.getTime()`. Typed as `string | null` and parsed explicitly.
15. **DST gap suggestions drifted** because the gap window was derived from the requested
    minutes. Rewritten around a binary-search `findOffsetTransition`.

---

## Phase 10 — Messaging, notifications and documents — **complete**

### Notifications (`src/services/notifications.ts`)

Every event CLAUDE.md §18 lists: offer sent · acknowledged · declined · timeout/escalation ·
assignment completed · operations override · request confirmed · request cancelled · line
failed. Each records an in-app entry and, where the event warrants interrupting someone, an
email.

**The guarantee is "never send duplicate notifications on job retries", and it is held by the
database, not by the queue.** `notification_deliveries.idempotency_key` carries a UNIQUE
index, so inserting the delivery row *is* the claim on sending the message: if the insert
does nothing, somebody already owns it and the transport is never contacted. BullMQ's job-id
deduplication is the first line, but only the constraint survives a Redis flush, a worker
restart or a deploy mid-job — so the code treats the insert as the authority.

In-app rows and delivery rows are separate on purpose: a person sees the notification in the
product whether or not their email ever left the building. Proven by test — with a transport
that refuses every connection, the dispatch still succeeds, the delivery rows read `failed`
with the reason, and the in-app notification is there.

A notification never fails the operation that caused it. The business write has already
committed; rolling it back for an unreachable mail server would be far worse than a missing
email.

### Email transport (`src/lib/mail/`)

One interface, three implementations chosen by `MAIL_TRANSPORT`: **smtp** (Mailpit locally,
SES later), **log** (the default, so a bare checkout never reaches for a mail server) and
**memory** (tests assert on what was actually sent). The log transport deliberately does not
log the body — operational emails carry passenger names and numbers.

### Message threads (`src/services/messaging.ts`)

Three scopes: `internal` (operations and admin), `provider` (operations and exactly one
company) and `client`. The database enforces the pairing via
`message_threads_scope_consistent`, and every read goes through one visibility predicate, so
"provider A reads provider B's thread" is not a join a query could forget.

An **internal** note and a **provider** conversation are separate threads with separate
visibility rather than one thread with a flag — an internal remark about a provider's
reliability must not be one mis-click from reaching them.

The provider thread opens automatically when an offer is sent, so a provider has somewhere to
ask a question the moment they see the work. Lifecycle entries are marked `is_system` and
rendered differently from prose: "the offer expired and this re-matched" is the platform
narrating itself, not a colleague giving an instruction.

Surfaces: `/ops/messages`, `/provider/messages`, a thread page under each, and a
conversations panel on the request page.

### Notification centre

`/ops/notifications`, `/provider/notifications`, `/admin/notifications`, with an unread
badge in each sidebar read on every navigation. Rows are scoped to the signed-in user by the
query itself; marking read adds `user_id` to the WHERE clause rather than checking ownership
and then writing, so there is no window between the two and no id worth guessing.

### Documents (`src/services/documents.ts`, `src/lib/documents/pdf.ts`, `src/lib/storage/`)

Three kinds generated, all real PDFs: **client confirmation**, **provider work order**,
**handling summary**. Every factual field is read from the request record — no model writes a
tail number, a time or a provider name.

**The PDF writer is hand-written and adds no dependency.** These documents are typeset text,
which the format's own base-14 fonts already do; a PDF library would bring a font pipeline for
no gain. It emits PDF 1.4 with a correct cross-reference table in about two hundred lines. The
tests check the xref offsets actually point at their objects and that characters outside
Latin-1 are transliterated rather than written as raw bytes — a file a reader refuses is
indistinguishable from no document at the moment somebody needs it.

Two properties are enforced and tested on the bytes themselves, not just the row:

- a **work order contains one provider's work and nobody else's** — the test asserts every
  other company's name is absent from the PDF, because a forwarded file cannot be recalled;
- a work order carries **no passenger contact details** — contacts are released per line, by
  an explicit decision, through the product.

Documents are immutable: regenerating writes a new row with a new storage key, so the
confirmation a client received last Tuesday is still retrievable exactly as they received it.

Storage keys are generated, never taken from input, and `/api/documents/[id]` decides access
from the record rather than the URL. A client may read only client-facing kinds even on their
own request; a provider only what is addressed to them; every successful read is audited.

The S3 driver is declared and deliberately throws a configuration error naming what is
missing, rather than silently writing to local disk on a production host and losing every
document on the next container replacement. It is wired in Phase 13.

---

## Quality gates — Phase 10

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm run build` | **pass** — every new route compiled |
| `npm test` | **pass** — **342 tests** |
| `npm run test:integration` | **pass** — **203 tests** (+50 for Phase 10) |
| `npm run verify:rbac` | **33/33** |
| `npm run verify:routing` | **194/194**, now 8 navigation links per provider |

Manually verified against the running build: `/api/documents/[id]` answers **401**
unauthenticated and **404** for a malformed id.

---

## A bug the Phase 10 tests caught

16. **Nobody was told when a request was cancelled.** `cancelRequest` withdraws every live
    offer, and the notification then asked which providers were holding live work — by which
    point the answer was nobody. The providers who were about to send a car were never
    emailed. The affected companies are now captured *inside* the transaction, before the
    withdrawal, and carried on the event. This is the general shape of the hazard: a
    notification composed after the fact cannot describe a world the operation has already
    changed.

---

## Phase 11 — Evals and hardening — **complete**

### The intake eval — 72 cases

`tests/evals/cases/intake-cases.ts` covers every category §26 names: ICAO and IATA supplied,
airport by name, city ambiguity, missing airport, relative dates, overnight, multi-service,
absent quantities, casual and malformed language, corrections, ambiguous "car", bodyguard
synonyms, rooms versus nights, catering detail, fuel with no amount, hangar duration.

The suite runs in two modes against one corpus and one set of scoring functions:

- **offline** (the CI default) scores the **deterministic extractor** — the path Journey E
  depends on when the model is down. Its thresholds are what that path can honestly achieve;
- **online** (`AI_ENABLED=true`) scores the real model.

Scripting the right answer per case and asserting we got it back would measure nothing, so
offline measures a real implementation instead.

**Measured against live OpenAI on 2026-09-15, prompt `intake.extract` v1.1.0:**

| Metric | Result |
| --- | --- |
| service classification | **100.0%** (72/72) |
| airport token | **97.2%** (70/72) |
| quantity | **97.4%** (37/38) |
| arrival time | **95.2%** (60/63) |
| departure time | **100.0%** (3/3) |
| passengers | **100.0%** |
| missing-field recall | **85.7%** |
| **hallucination rate** | **0.0%** |
| latency p50 / p95 | 1.6s / 2.4s |

The online thresholds in the suite are regression guards set just under these, with a margin
for model non-determinism. A number that drops below one has regressed and should be
investigated, not lowered.

### The matching eval

Six shortlists, each posing a judgement §10 permits — spare capacity, consolidation,
lead-time margin, a crowded five-way. **Validity 100%, fallback 0%** against the live model.

Agreement with the deterministic top rank is measured (66.7%) and deliberately **not**
required to be high: if the model always agreed there would be no reason to ask it. What is
required is that every answer names a provider that was actually on the shortlist.

Six further cases prove the model cannot break matching however it misbehaves: an id that was
never offered, prose instead of JSON, an empty reason, a timeout, an unavailable provider, a
refusal — each is classified correctly rather than half-trusted.

### The research eval — Journey F

Twelve questions. Against the live model: **12/12 answered, 4/4 action requests refused, 3/3
missing-data questions owned**. Assertions include that the assistant never claims to have
acted, never invents a figure, and cites the actual reason codes from the trace.

### AI boundary tests (§25) — 20 assertions

Each rule the brief lists, asserted individually: AI decision modules import no database,
drizzle or queue and contain no mutation; the matching prompt's candidate type is an
allow-list of computed facts and cannot accept a provider registry; the adapter never imports
the eligibility functions; the research assistant declares **zero** tools and its service
imports no offer, assignment, intervention or governance module; no SDK other than OpenAI is
imported anywhere and the AI layer makes no network call of its own; the eval suite imports
the real prompts rather than copies.

### Security tests (§27) — 26 assertions

No hard-coded key, token or private key; no secret-bearing value passed to a logger; `.env`
gitignored and `.env.example` blank; client components read only `NEXT_PUBLIC_` variables and
import no database, queue or AI module; every server action establishes an actor and performs
an explicit capability check; no action trusts a role or actor id from the form; no SQL built
by concatenation; document content types are an allow-list with no `text/html`,
`application/javascript` or `image/svg+xml`; session tokens stored only as hashes, compared in
constant time; no `eval` or `new Function` anywhere.

Two files are exempt from the capability rule and the exemptions are **named in the test**
with reasons — sign-in cannot establish an actor first, and the notification actions are
scoped to the caller's own rows, which a further assertion verifies.

### Accessibility checks (§21) — 18 assertions

Static, non-recording (ADR-014): every image has alt text and decorative images are
`aria-hidden`; no click handler on a non-interactive element; every button declares its type;
icon-only controls carry a name; every form control is labelled or wrapped; `main`, `nav`,
`aria-current`, table `caption` and `role="alert"` all present; status is text, never colour
alone; no font size below 11px.

---

## Quality gates — Phase 11

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **413 tests** (was 342) |
| `npm run test:integration` | **pass** — **203 tests** |
| `npm run test:evals` | **pass** — **34 assertions**, offline |
| `npm run test:evals` with `AI_ENABLED=true` | **pass** — same 34 against live OpenAI |
| `npm run verify:rbac` | **33/33** |
| `npm run verify:routing` | **194/194** |

---

## Bugs Phase 11 caught

17. **Intake extraction had never once worked against the live OpenAI API.** The generated
    JSON schema was rejected with **400 Invalid schema**, because `requirements` was a
    `z.record()` and strict structured outputs cannot express an open-ended map — every
    object must declare its properties up front. The adapter degrades on any provider error,
    so intake silently fell back to the deterministic extractor on *every call*. Nothing
    failed, no test noticed (the scripted adapter does not convert schemas), and the product
    simply never used the model for intake.

    Fixed by modelling requirements as a list of `{ key, value }` pairs with a transform back
    to a record — open-ended *and* strict-compatible, and a wire-format detail the domain
    never sees. Two guards were added so this cannot recur: `enforceStrict` now **throws**
    on an open-ended object naming the construct and the fix, and
    `tests/unit/ai/prompt-schemas.test.ts` converts every registered prompt offline and
    checks it against OpenAI's published strict-mode rules.

18. **"Provider error 400" was all the adapter reported.** Exactly the generic failure §28
    forbids, and the reason the bug above took a live eval run to find. The provider's own
    message — which names the offending field and contains no secret — is now included.

19. **A 24-hour time could be read as a quantity.** "PALM BEACH MONDAY 1300 TWO CARS" made
    the deterministic extractor produce a quantity of 1300, which is outside the extraction
    schema's range — so the *fallback* path would itself fail validation and hand the
    operator an error instead of a form. Digits are now limited to one or two and bounded.

20. **Sidebar and login labels were 10px**, against §21's "no tiny unreadable text". Raised
    to 11px; the accessibility suite now enforces the floor.

21. **The standalone server served pages with no CSS and no JavaScript.** `next build`
    emits `.next/standalone` that deliberately omits `.next/static` and `public/` — it
    assumes a container image or a CDN will supply them, and the Dockerfile does exactly
    that. But running `node .next/standalone/server.js` straight from the repo skips those
    copies, so every stylesheet, script chunk and image 404s while every page still returns
    **200**. The result is raw unstyled HTML with no hydration: it looks like a backend with
    no front end, and nothing warns you.

    **`npm run verify:routing` passed 194/194 against that build.** It checked the status of
    every page and every navigation link and never fetched a single asset those pages
    referenced. A gate that green-lights an unusable application is worse than no gate,
    because it is believed.

    Two fixes. `npm run build` now runs `scripts/prepare-standalone.mjs`, which performs the
    copies, so a build is runnable by definition rather than by remembering. And the routing
    verifier now fetches each page's own stylesheets and a sample of its scripts and fails
    if any does not return 200 — the check count rose from 194 to **248**. The Dockerfile
    was already correct; the drift was between the documented container path and the local
    one, which is precisely the gap the new check watches.

## Corpus corrections worth naming

Two groups of eval cases encoded *my* expectation rather than the product's deliberate rule,
and the cases were corrected rather than the product:

- **"hotel for nine"** is nine guests or nine rooms, and the sentence does not say which.
  Prompt rule 5 requires an ambiguity rather than a guess — booking nine rooms for nine
  people sharing would be an expensive wrong answer. The cases now assert the ambiguity.
- **"catering for six"** is six covers, which belongs in requirements. It says nothing about
  how many people are on the aircraft, so grading it as the passenger count was wrong.

## A prompt improvement, measured

Rule 3 gained "a bare weekday is a date" and rule 8 gained "quantity". Prompt version bumped
to 1.1.0 (§24: prompts are code). Measured effect on the same 72 cases:

| Metric | v1.0.0 | v1.1.0 |
| --- | --- | --- |
| arrival time | 74.6% | **95.2%** |
| quantity | 80.0% | **97.4%** |
| passengers | 55.6% | **100%** |
| missing-field recall | 42.9% | **85.7%** |
| airport token | 95.8% | **97.2%** |

---

## Next

Phase 12 — local production rehearsal: full Docker build, no dev-only assumptions,
restart/retry behaviour, migration and seed documentation, backup/restore notes, smoke-test
script. Then Phase 13 (AWS Terraform).

**Reserved for the very end, at the user's request:** wiring the real click-through flow so
the whole journey can be exercised by hand — client composer → confirm → matching → provider
queue → acknowledge → assign → operations sees it.


---

## Review pass — what a walk through the running product found

Four things the automated gates all passed and a person spotted in a minute.

### 22. Two navigation items were highlighted at once

On `/admin/requests` both *Overview* and *Request oversight* were marked current, in every
portal, because `isActive` matched the portal root as a prefix of every page beneath it.
`aria-current="page"` was announced twice, and a reader could not tell where they were.

Replaced with `activeNavHref`, which resolves the single longest match, so "exactly one" is a
property of the function rather than something each caller arranges. Thirteen unit tests, and
a live check in `verify:routing` — the unit test cannot catch a middleware-header regression,
which is the other way this breaks.

### 23. The click-through flow was broken in two places

`confirmRequestAction` created the request and **never enqueued matching**, so every line sat
in `matching` for ever, no offer was dispatched, and no provider ever saw the work. CLAUDE.md
§8 step 4 says "enqueue matching"; nothing in `src/app/` or `src/domain/` called
`enqueueMatching` or `dispatchNextOffer` at all.

And the **"Confirm and create request" button was dead** — `<Button type="button">` with no
handler, so `confirmRequestAction` was never reached in the first place.

Every individual piece had passing tests. Intake worked, matching worked, offers worked,
assignment worked. The *sequence* did nothing. `src/services/request-dispatch.ts` is the join,
with `tests/integration/journeys/click-through.test.ts` asserting the sequence end to end:
confirm → match → provider queue → acknowledge → assign → operations sees it.

Two paths, because the product is used both ways: with the queue on, lines are enqueued and
the worker dispatches; with it off, dispatch runs inline so a developer with no Redis still
gets a working flow rather than a silently dead one.

### 24. Two pages were still hard placeholders

`/admin/requests` said "Needs Phase 6 — request lifecycle" and queried nothing. `/ops/research`
said "Phase 5 — match traces, and Phase 8 — the assistant surface". Both phases had been
complete for a long time.

`/admin/requests` is now the governance view §14 asks for — overrides, failed lines,
unverified model choices, declined and expired offers, audit counts, exceptions surfaced above
the table. `/ops/research` is a request chooser driving the assistant, with `?request=<id>` so
a link can open it already pointed at the right request.

Also removed four more stale "arrives in Phase N" promises, three of them user-facing.

### 25. Provider self-management did not exist

The four `provider.manage.*` permissions were defined and granted, and **no action used
them**. A provider could not add a vehicle, retire a driver, or change its own capacity — so a
company that bought a car could not take work with it.

`src/services/provider-self.ts` adds vehicles, drivers and officers, retires and restores
them, and edits coverage capacity and lead time. Two rules carry the weight, and both are
tested:

- **Deactivating is not deleting.** History is kept; the resource stops being matched.
- **A resource committed to future work cannot be retired.** Otherwise a provider could
  quietly retire the car meeting tomorrow's arrival and nobody would find out until the
  client was standing on the ramp.

Scoping is in the WHERE clause of the write, so another company's id matches nothing rather
than being caught by a check someone could forget.

### Also built

- `/client/requests/[id]` — the request status page §1 requires, in plain language. A supplier
  is named only once they have accepted, because naming one who then declines invites the
  client to chase a job nobody holds.
- A list of the client's own requests under the composer, so a reference can be found again.

---

## Quality gates — review pass

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **426 tests** |
| `npm run test:integration` | **pass** — **225 tests** |
| `npm run verify:rbac` | **33/33** |
| `npm run verify:routing` | **340/340** |

A page-level audit (`scripts/diag-pages.ts`) confirms **no placeholder remains** on any of the
28 authenticated pages.


---

## UI/UX refinement and visual asset cleanup

A controlled presentation-only pass. **No business logic, domain logic, schema, migration,
API, server action, RBAC rule, matching behaviour, AI flow, lifecycle, job or persistence
was touched.** Every change below is what is rendered, never what is decided.

### Development credentials removed from the sign-in page

The sign-in panel printed the seeded admin, operations and provider addresses **and the
password** in a card. It was gated to `APP_ENV === 'local'`, so it would not have shipped —
but it was on screen during every local session, and a password rendered into HTML is a
password that ends up in a screenshot, a recording or a support ticket.

Removed outright. The credentials still exist where they belong: the seed script prints
them once, and they are in the local setup documentation. `scripts/diag-ui.ts` asserts the
public sign-in page carries none of them.

### The cartoon aircraft is gone

Every one of the five atmospheric backgrounds — sign-in, client hero, and all three
sidebars — used the same clip-art aircraft: a blob fuselage with oval engines and toy
proportions. It is on the brief's explicit "avoid" list, and it undercut the rest of the
product.

Replaced with photorealistic private-aviation photography supplied for the project
(`scripts/ingest-photography.mjs`, re-runnable):

| Asset | Subject | Why this crop |
| --- | --- | --- |
| `login-auth.webp` | Business jet at a hangar entrance, blue hour | Dark values suit the navy panel; open sky falls on the left, under the wordmark and copy |
| `client-hero.webp` | Business jet on an apron at sunrise | Warmer and calmer — a client is being reassured, not shown a console |
| `ops-sidebar.webp` | Apron at sunrise, cropped tall | Tone over subject: at 14% opacity only light and shape survive |
| `provider-sidebar.webp` | Aircraft and sunrise at an FBO | Cropped away from the vehicle and the figure — a recognisable person behind navigation reads as a subject, not atmosphere |
| `admin-sidebar.webp` | Hangar at blue hour, darkest crop | Admin is the most restrained portal (§21) |

The overlays were retuned. A 45% image opacity under a heavy three-stop gradient had been
tuned for clip-art; applied to a real photograph it produced a muddy rectangle. Both heroes
now use a horizontal pass that holds contrast **where the copy is** and releases where it is
not, plus a light vertical pass to seat the wordmark and the legal line.

The stale hand-drawn `*.svg` sources were deleted rather than left beside the photographs
they no longer describe, and `ASSET_MANIFEST.json` was rebuilt from disk — it still listed
the deleted files and pre-replacement byte counts.

**Provenance is recorded in the manifest**, as §21 requires. None of the imagery depicts a
specific named airport, and none is ever captioned as one: where a place must be identified
the product renders the ICAO, IATA, name and stored coordinates as data beside the image.

### Avatars showed the wrong person's initials

Three static SVGs carried **hard-coded initials** — `JD`, `SP`, `OP` — assigned by hashing
the user id. Every signed-in person was shown somebody else's monogram; "Sofia Lindqvist"
appeared as "SP".

`src/components/ui/monogram.tsx` derives initials from the actual name, with a stable colour
per subject. Nothing is stored and no image is fetched. The same component is the provider
logo fallback, so a company without an uploaded logo gets a clean monogram rather than a
fabricated luxury-brand mark.

### Settings and feature flags read as a product

`matching.max_rematch_attempts` now displays as **Maximum rematch attempts**, grouped under
**Matching**, with its unit. The raw key is still rendered, small and secondary, because an
administrator reading an audit event needs to connect the two.

`src/lib/settings-labels.ts` is a presentation map only — **the key remains the identity**
in the database, the audit trail and every read. Matching and the Acknowledgement SLA sort
first, because those are what an administrator reaches for when something is going wrong.

`tests/unit/ui/settings-labels.test.ts` compares the map against the seeds, so a new setting
cannot silently render as a raw dotted key. The humanising fallback stays a safety net
rather than the normal path.

### Left deliberately unchanged

- **Status badges** already render `awaiting_confirmation` as "awaiting confirmation", and
  the client surface already speaks plainly ("Finding a supplier", "Our team is on it").
- **Tables** already scroll horizontally inside their own container; responsive behaviour
  needed no change.
- **The audit explorer's entity ids** stay visible. They are forensic data for an
  administrator mid-investigation, not a debug aid.
- Icons, empty/loading/error primitives and the component library were already consistent.

### Quality gates — refinement pass

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **436 tests** |
| `npm run test:integration` | **pass** — **225 tests** |
| `npm run test:evals` | **pass** — **34 assertions** |
| `npm run build` | **pass** |
| `npm run verify:rbac` | **33/33** |
| `npm run verify:routing` | **340/340** |
| `scripts/diag-pages.ts` | no placeholder on any of 28 authenticated pages |
| `scripts/diag-ui.ts` | labels render, monogram replaced the static avatars, no credentials on `/login` |

### The application now runs in Docker

Previously only `postgres`, `redis` and `mailpit` were up, which is why no application
container appeared — the app had been run natively for fast iteration. Both application
images are now built and running:

```
web       Up (healthy)   0.0.0.0:53000->3000/tcp     465 MB
worker    Up                                       1.12 GB
postgres  Up (healthy)   0.0.0.0:55432->5432/tcp
redis     Up (healthy)   0.0.0.0:56379->6379/tcp
mailpit   Up (healthy)   0.0.0.0:58025->8025/tcp
```

**All four portals are served from the container at `http://localhost:53000`.**

Verified against the container, not against the native process:

| Check | Result |
| --- | --- |
| `/api/health` | database ok (2 ms), redis ok (1 ms) |
| Feature flags reported by the container | `aiEnabled: true`, `queueEnabled: true`, `rateLimitEnabled: true` |
| `npm run verify:routing` | **340/340** |
| `npm run verify:rbac` | **33/33** |
| `scripts/diag-ui.ts` | all checks pass; no development credentials on `/login` |
| Stylesheet, script chunk, background image | 200, served from the image |
| Worker | running the expiry sweep and re-matching lines — real work, visible in its log |

The OpenAI key reaches the container through Compose's `${OPENAI_API_KEY}` substitution from
the gitignored `.env`, which is why the container reports `aiEnabled: true` rather than
falling back to the deterministic path.

`migrate` and `seed` remain one-shot services that exit by design; the schema and reference
network were already applied to the shared Postgres volume.

The native standalone server on port 3001 is still available for fast iteration. Both hit
the same database, so they show the same data — **53000 is the containerised one.**


---

## Bug fixes and UI polish pass

### The research assistant was broken by a log-formatting preference

Reported as "the operations research assistant does not answer". The service itself was
fine — calling `askAboutRequest` directly returned a correct answer and `ai_calls` recorded
`success`. The failure was underneath it:

```
⨯ Error: unable to determine transport target for "pino-pretty"
```

`pino-pretty` is a **devDependency** — a developer convenience, deliberately absent from the
production image. The logger asked pino for it whenever `LOG_PRETTY` was set, and
`docker-compose.yml` passes `LOG_PRETTY` through from `.env`, where it is `true`. So the
container constructed a transport for a package it did not have, and threw.

Because `logger()` runs at the head of every server action, a preference about log
*formatting* became a broken application — and it broke **only in the image**, never on a
developer's machine, which is the worst place for a bug to hide.

`createRootLogger` now degrades to structured JSON instead of throwing, and says so once.
JSON on stdout is the correct production behaviour anyway. `tests/unit/logging/` pins the
fallback, keeps `pino-pretty` a devDependency (promoting it would grow the image for a
developer convenience) and checks the container still defaults `LOG_PRETTY` to false.

### A misleading internal error on every `/client` redirect

23 occurrences of `Client account is not linked to an organisation` in the container log.
No client user is actually missing an organisation — the App Router renders a layout and its
page **in parallel**, so when an operations or admin user hits `/client` the page's guard ran
even though the layout was already redirecting them away.

The end state was always correct (a 307 to their own portal); only the log was wrong. The
guard now redirects in agreement with the layout rather than throwing an internal error.
**No behaviour change** — same destination, same status code.

### Client — "What we can arrange" is now service cards

The plain six-cell text grid became premium cards: a 16:10 photograph, the service name, its
existing description, a subtle hover lift and image scale, and a restrained navy wash so six
photographs read as one set.

Still driven entirely by the live catalogue through the existing `services` prop — **nothing
is hard-coded**, so a category an administrator adds appears with the rest (ADR-008). The
image path is derived from the category code by the existing `serviceImageFor` helper, so
adding a service needs no artwork before it can appear; a code with no photograph falls back
to its icon on a tinted field rather than a broken image.

`auto-rows-fr` plus `h-full` keeps every card the same height whatever the description
length, and the aspect ratio is fixed at ingest rather than in CSS, so the grid cannot go
ragged.

Six supplied photographs ingested to `06_service_images/` at a consistent crop
(`scripts/ingest-service-images.mjs`). The filenames and the `serviceImages` registry were
already in place, so only the bytes changed — no code reference moved.

**The request input, submission flow, buttons and lifecycle are untouched.**

### Internal identifiers are no longer primary UI text

`src/lib/domain-labels.ts` joins `settings-labels.ts` as a presentation-only map. **The value
remains the identity** in the database, the matching engine and the audit trail.

| Where | Was | Now |
| --- | --- | --- |
| Admin → Service catalogue | `vehicle_with_driver` | **Vehicle with driver**, with what it means for matching; raw value kept as small secondary metadata |
| Admin → Service catalogue (create form) | `hotel_rooms — coverage, hours…` | **Hotel rooms** |
| Admin → Audit explorer | `provider_company.approve` | **Provider approved**; raw action kept beneath, since that is what a log query cites |
| Operations → Request history | `request.override_provider` | **Provider overridden by operations** |
| Operations → Research | `AI_ENABLED=true` quoted at a controller | "An administrator can switch it back on" |

`tests/unit/ui/domain-labels.test.ts` compares the maps against the real enums, so a new
assignment strategy or AI stage cannot silently render raw. The humanising fallback stays a
safety net rather than the normal path.

Left deliberately: the **permission matrix** on Admin → Users keeps its permission names.
That table is an explicit technical reference, already rendered as secondary mono chips, and
renaming 38 permissions would be a large change with real risk for no reader benefit.

### A second wave the source test could not see

The source guard checks for `replace(/_/g, ' ')`. That finds a page *converting* an
identifier, but not a page that simply **renders one that arrived from the database** —
where nothing in the source looks wrong at all.

So the running build was fetched, page by page, with the scripts and attributes stripped and
the remaining visible text scanned for `snake_case`. Five pages still leaked:

| Page | Was | Now |
| --- | --- | --- |
| Admin · Users | 38 permission keys, `request.view.own_client` | **View their own requests** (key kept as the tooltip) |
| Admin · Audit | actor role `provider_dispatcher` | **Dispatcher** |
| Admin · Audit | entity `request_service_line`, `provider_offer` | **Service line**, **Provider offer** |
| Admin · Audit | reason-required badges `override_provider` | **Provider overridden** |
| Admin · Catalogue | declared field keys `room_type` | the field's own `label`, key kept small |
| Admin · Catalogue | options `junior_suite`, `avgas_100ll` | **Junior suite**, **Avgas 100LL** |
| Admin · Settings | confirm dialog "Turn off `sms_enabled`?" | "Turn off **Text-message alerts**?" |
| Provider · Resources | `armored_b6`, `run_flat` | **B6 armour**, **Run-flat tyres** |

Two of these were worth more than the wording. The catalogue was rendering `field.key` while
the config schema **already carried a `field.label`** nobody was reading. And `avgas_100ll`
had passed the enum test — `humanise` made it "Avgas 100ll", which contains no underscore
and is still wrong. It is now mapped explicitly to **Avgas 100LL**.

### What deliberately still shows a key

Three surfaces keep the raw value as small secondary text under a readable name, and this is
a decision rather than an oversight:

- **Platform settings and feature flags** — the key is what the audit trail records.
- **Service category code and matching strategy** — what the engine switches on.
- **Audit action** — what a support thread or a log query cites.

An administrator answering "which rule fired?" needs the exact token. The change is that it
is never the *first* thing read, and never the only thing.

The permission matrix is the one place the key moved out of the text entirely: 38 keys in a
grid is a data dump, not a governance answer. The key is now each entry's tooltip, so it is
one hover away rather than gone.

### Guarded from both sides

`tests/unit/ui/no-raw-identifiers.test.ts` grew to **31 assertions**, now covering values
that live in data rather than in an enum: every permission has a distinct English phrase;
every `entityType` any write records has a name — read out of the source, so a new entity
type fails the test rather than shipping; and seeded vehicle tags read as equipment. Free-form
tags keep a `humanise` fallback, since a provider can invent one this build has never seen —
`bullet_resistant_glass` reads as "Bullet resistant glass", never raw.

`scripts/diag-raw-identifiers.ts` re-runs the live sweep against a running build.

### Quality gates

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **452 tests** |
| `npm run test:integration` | **pass** — **225 tests** |
| `docker compose build web worker` | **pass** |


---

## Plain-language pass across all four portals

A sweep for internal identifiers reaching a user — anything rendered as `snake_case` where a
person should be reading English. **Presentation only.** No key, enum member, column or
configuration value changed; every value still stored, matched on and audited exactly as
before.

### What was showing raw

| Portal | Was | Now |
| --- | --- | --- |
| Admin · Users | `platform_admin`, `provider_dispatcher` | **Platform administrator**, **Dispatcher** |
| Admin · Users | `invited`, `suspended` | **Invited**, **Suspended** |
| Admin · Providers | `pending` | **Awaiting approval** |
| Admin · Requests | `awaiting_confirmation`, `in_progress` | **Awaiting confirmation**, **In progress** |
| Admin · AI reliability | `schema_invalid`, `verification_failed` | **Invalid response**, **Failed verification** |
| Admin · AI reliability | `intake`, `matching`, `research` | **Reading a request**, **Choosing a provider**, **Answering a question** |
| Operations · Requests | `sourcing`, `partial`, `failed` | **Finding providers**, **Partly covered**, **Needs attention** |
| Operations · Request detail | `hotel_room` | **Hotel room** |
| Operations · Request detail | `waiting`, `rematching` | **Awaiting response**, **Re-matching** |
| Operations · Request detail | offer `sent` | **Awaiting response** |
| Provider · Resources | `armored_suv`, `suv` | **Armoured SUV**, **SUV** |
| Provider · Resources | `off_duty`, `maintenance` | **Off duty**, **In maintenance** |
| Provider · Resources | `jet_a`, `saf_blend` | **Jet A**, **SAF blend** |
| Provider · Team | `provider_staff` | **Staff** |
| Messages | author role `operations_manager` | **Operations manager** |
| Offer card | priority `urgent` | **Urgent** |

Twelve files, all routed through `src/lib/domain-labels.ts`.

### Wording is chosen per audience, not shared

The same state reads differently depending on who is looking, which is the point:

- a service line at `offered` is **"Awaiting response"** to a controller, who needs to know
  the provider has it and has not answered;
- the same line is **"Finding a supplier"** to a client, who does not need to know a
  particular company is deciding right now.

Operations wording lives in the registry; the client's lives on the client page, where it
was already deliberate.

### `replace(/_/g, ' ')` is not a fix

Ten pages were stripping underscores inline. That looks like a solution and is not — it
turns `awaiting_confirmation` into "awaiting confirmation" (lowercase, no product voice) and
`jet_a` into "jet a". All ten now go through the registry, so the wording is decided once.

One exception is allowed and documented in the test: `decision-trace.tsx` calls
`describeReason` first and only strips underscores for a reason code from an **engine version
this build no longer describes**. That fallback is forward compatibility, not laziness.

### A miss my own test caught

`/client/requests/[id]` had `status.replace(/_/g, ' ')` as the `default` branch of its status
switch. Every real status was mapped, so it never fired in practice — but an unmapped one
would have shown a client an internal identifier. On a client surface that is the wrong
answer even as a fallback, so it now says **"Being arranged"**: safe, true, and no identifier.

### Guarded by tests, not by vigilance

`tests/unit/ui/no-raw-identifiers.test.ts` (26 assertions) checks both halves:

1. **Every enum member has a readable label** — compared against the real schema enums, so a
   new member added without a label fails the build rather than shipping.
2. **No page strips underscores by hand** — the whole `src/app` and `src/components` tree,
   with the one documented exception.

Plus a capitalisation check, because "in progress" as a badge reads like a fragment where
"In progress" reads like a status.

### Quality gates

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **478 tests** |
| `npm run test:integration` | **pass** — **225 tests** |
| `npm run build` | **pass** |
| `docker compose build web worker` | **pass** |


---

## Operational note — a build that hangs instead of failing (Windows)

Observed while rebuilding for the plain-language pass, and worth recording because the
symptom is misleading.

`npm run build` printed its banner and then sat for **24 minutes** producing no output, no
error and no `.next/BUILD_ID`. It looked like a slow build. It was not:

| Signal | Reading | What it meant |
| --- | --- | --- |
| CPU after 24 min wall | **50 seconds total** | ~3% of one core — the process was blocked, not working |
| Working set | flat at 104 MB | a real compile climbs past 400 MB |
| Output | banner only | it never reached "Creating an optimized production build" |

**Cause:** the standalone server was still running *from inside* `.next/standalone`. On
Windows an executing file is locked, so `next build` blocked trying to clear `.next` — and
blocked silently rather than reporting a locked file.

**Fix:** stop the standalone server before building. With the lock gone the same build
compiled in **12.5 seconds**, with CPU climbing ~2 cores and memory to 416 MB — the profile
a real build has.

Two things follow for Phase 12:

1. The smoke/rehearsal script must **stop the server before it builds**, not after. A build
   that hangs with exit code 0 pending is worse than one that fails.
2. This is one more reason the Docker path is the reference: the container builds into its
   own image with nothing executing from the output directory, so the lock cannot occur. The
   Docker stack stayed up and healthy throughout this incident.

A useful check when a build looks slow: sample its CPU twice a few seconds apart. Rising CPU
means it is working; flat CPU means it is blocked and waiting will not help.


---

## Two real defects the plain-language sweep uncovered

Neither was a wording problem. Both were found by checking the **running** pages rather than
the source, and both had a passing test sitting next to them.

### 1. Eight audit actions had no label, because the labels named keys nothing emits

`AUDIT_ACTION_LABELS` looked complete. It was not — several entries were written against a
*guessed* key:

| The map said | The service actually emits |
| --- | --- |
| `offer.acknowledged` | `offer.acknowledge` |
| `offer.declined` | `offer.decline` |
| `offer.expired` | `offer.expire` |
| `auth.sign_in` | `auth.login` |
| `request.override_provider` | `request_line.override_provider` |
| — | `auth.logout` |
| — | `request_line.match_failed` |
| — | `request_line.rematch_ceiling` |

Every one of those rows fell through to `humanise` and rendered in the audit explorer as
**"Offer.acknowledge"** and **"Request line.match failed"** — an internal identifier on the
platform's governance surface, which is precisely where it must not appear.

Fixed by labelling what the code emits. The guard is
`tests/unit/ui/no-raw-identifiers.test.ts`, which now reads the action strings out of the
real `recordAuditEvent` call sites: a label written for a key nothing emits can no longer be
mistaken for coverage.

### 2. The reason-required pre-check never fired

CLAUDE.md §5 requires a written reason for overrides and suspensions. `REASON_REQUIRED_ACTIONS`
listed `request.override_provider` and `provider.suspend`; the services emit
`request_line.override_provider` and `provider_company.suspend`. The names never matched, so
`requiresReason()` returned false for every action it was meant to catch.

**The rule still held.** The `audit_events_reason_required` check constraint in migration
0002 uses the correct, actually-emitted names, and the database is the enforcement
(CLAUDE.md §30). So this was never a hole — a reasonless override was rejected, just by
Postgres, reported as a constraint violation instead of a clear typed error.

The list now mirrors the constraint, and a test parses the constraint out of the migration
and asserts the two agree. If they ever diverge again the build fails, rather than the
application silently deferring to SQL for its error messages.

**Why the existing test did not catch it:** it asserted `requiresReason('request.override_provider')`
— checking the list against its own contents. A test that draws its inputs from the thing it
is testing cannot detect that the thing is disconnected from reality. It now uses the names
the services emit.

### Findings that were not defects

Reported honestly, because a diagnostic that cries wolf is worse than none:

- **`/ops/messages` and `/provider/messages` link nowhere.** Correct: there are zero message
  threads in the local database, because the scenario data was seeded on 2026-09-14, before
  the Phase 10 messaging code existed. Thread creation on offer dispatch is already covered
  by `tests/integration/messaging/threads.test.ts`. The scenario seeder is non-destructive
  and refuses to re-run, so the existing data was left alone. The diagnostic now distinguishes
  an empty list from a dead one.
- **`diag-client-cards` exited 127.** Every check inside it passed, including all six service
  images at HTTP 200. The crash was `closePool()` immediately followed by `process.exit()`
  racing libuv's teardown on Windows. A crash after the work succeeds reads as a product
  failure and is not one.


---

## Verification of the running application

Run against the built standalone server, not the source — every portal, every page.

| Step | Result |
| --- | --- |
| Routing — every role, every route | **340/340** |
| RBAC — cross-tenant isolation | **33/33** |
| Every page renders real content | **29/29**, no placeholders |
| No raw identifiers reach a user | **clean everywhere** |
| Sidebar active state | one item per route |
| Client service cards | 6/6 images, markup and hover intact |
| Operations research assistant | answered from the trace, refused the action |
| Intake · matching · research | all three real model paths |

Seven pages report as "thin". Each was opened and reads as a written empty state — *"Nothing
waiting. Offers appear here as operations dispatches them."* — not a blank. Two of the seven
in fact carry data: `/ops/schedule` shows an arrival and `/provider/schedule` shows a covered
assignment; they are simply short pages.

### Two diagnostics that were wrong about the product

Worth recording, because a check that reports a healthy system as broken costs more than no
check at all.

**A crash after success.** `diag-client-cards` exited 127 with
`!(handle->flags & UV_HANDLE_CLOSING)` *after* printing six passing image checks. The cause
was keep-alive sockets from its own asset fetches outliving a forced `process.exit`. Fixed at
the source (`connection: close`) and by letting the loop drain instead of forcing it — the
run now exits 0 repeatably rather than intermittently.

**Deliberate provenance read as a leak.** `/admin/audit` prints each event's raw action under
its English label, the same documented pattern as the settings keys and catalogue codes. The
sweep could not tell that apart from a genuine leak. Rather than add another allowlist, the
check now **proves the label rendered**: a raw action is tolerated only when its readable
label is also on the page. If a label ever stops rendering, the raw value stops being
excused — so the exception cannot rot into a blind spot.

### Gates

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **487 tests** |
| `npm run test:integration` | **pass** — **225 tests** |
| `npm run build` | **pass** |
| `docker compose build web worker` | **pass** |


### Both runtimes verified, not just one

Earlier in this build a fix was verified on one server while the other still served an old
bundle, and the difference was reported as if it were a product fault. So the whole chain was
run twice.

| | Native standalone (3001) | Docker (53000) |
| --- | --- | --- |
| All eight verification steps | **PASS** | **PASS** |

The Docker run was proved to be genuinely against the container: the native server was
stopped first (`3001 -> 000`) and the sweep still passed clean against 53000. A result that
could have come from either server is not a result.

Full local stack healthy: web, worker, postgres, redis, mailpit.


---

## Intake clarification

### The gap

Intake showed what was missing and let the request be created anyway. Run against the real
model, this sentence —

> Landing at Teterboro Friday at 3am, two cars, three bodyguards, hotel for nine.

— produced a draft reported as **confirmable**, while the catalogue's own configuration said
six required fields were absent:

| Service | Required and absent |
| --- | --- |
| Ground transport | Vehicle class, Passengers to carry |
| Close protection | Officers required, Armed detail |
| Hotel | Rooms, Nights |

Pressing Confirm then failed inside `createRequest` with the validator's own words —
**"Ground transport: Required"** — which is true, and addressed to nobody.

**Cause:** `missingRequiredFields()` had been written and was never called. `isDraftDispatchable`
checked the airport, the times and that each service resolved, and then ignored whether those
services had the fields the catalogue says they cannot go without.

### The engine

`src/domain/requests/clarification.ts` is pure and generic. It holds no knowledge of ground
transport, hotels or fuel: it reads each category's declared fields out of
`config_schema_json` and asks for the ones that are required and absent.

Every field is classified, and only the first two block:

| State | Meaning |
| --- | --- |
| `blocking_missing` | Configuration requires it and it is absent |
| `blocking_ambiguous` | Stated, but it could mean more than one thing |
| `optional_missing` | Offered quietly; never blocks |
| `resolved` | Nothing to ask |

The control follows the declared type — enum to chips, boolean to Yes/No, integer to a small
number box, an entity to database-backed options — so a category added from Admin tomorrow is
asked about correctly with no component written for it. A test proves exactly that by
inserting an `aircraft_cleaning` category at runtime and asserting the questions it produces.

### What the model may and may not do

Configuration decides what is required. The model never does.

Its one contribution is the ambiguity it noticed, attached to the field that ambiguity is
about rather than raised as a separate question. So "hotel for nine" does not become a
question of its own — it becomes the note under **How many rooms?**:

> *unclear if 'nine' refers to guests or rooms*

Question wording is derived deterministically from the label and type, not generated. That
keeps the conversation identical with AI switched off, which is where a fallback has to be
good rather than absent (Journey E). The model is permitted to phrase questions under the
brief; it is not used for that here, because a question that changes wording between rounds
is harder to answer, not easier.

### Rounds

The draft is **not persisted** between rounds. A draft is not yet a request, and giving it a
row would make it one. The browser carries the state and posts it back — and none of it is
trusted: `rebuildDraft` re-reads every identifier from the database, exactly as
`confirmRequestAction` does, one round earlier.

- **Nothing already known is lost.** Answers merge into the existing state.
- **One answer can settle several questions.** Naming a service resolves its identity and
  brings its own requirements into the conversation.
- **An answer can raise a new one.** A field with `dependsOn` is not a question until its
  condition is met.

`dependsOn` is a shape a category's JSON may take, not a column — no migration, and every
seeded category omits it, so behaviour today is unchanged. `validateRequirements` honours it
too: a conditional field that nothing has asked for cannot be required, or the engine would
decline to ask for something creation then refuses for being absent.

### Loops

A question answered but still unresolved counts an attempt. Past three, the UI stops
repeating itself and offers a plain correction control — still blocking, because giving up on
asking is not the same as inventing the answer.

### Confirmation is gated in two places

The button reads the plan. The **server** enforces the same rule independently, because a
disabled button is not a control (CLAUDE.md §30). `confirmRequestAction` now names the fields
still outstanding instead of letting `createRequest` throw a validator message at the client.

### Start over

A read-back the user does not want should not trap them in it. **Start over** puts the draft
down and returns the empty sentence box. Nothing has been persisted at that point, so there
is nothing to undo.

### A bug the tests caught

The integration test for entity ambiguity failed on first run: airport candidates were lost
on the round trip, so a second round would ask *"which airport did you mean?"* and offer
nothing to choose from — the question surviving but its answers not, which is worse than not
asking. Candidate ids are now carried and re-read from the database.

### Untouched

Matching, provider selection, ranking, the state machines, request statuses, queues,
notifications, RBAC, routes, migrations, and what Confirm does after confirmation. The change
is confined to intake: one new pure engine, one new server action, one new component, and the
`isDraftDispatchable` rule that was incomplete.

### Tests

| Suite | Cases |
| --- | --- |
| `tests/unit/requests/clarification.test.ts` | **24** — trip-level and service-level gaps, ambiguity, several services, conditional requirements, a runtime-configured service, loop ceiling, no-preference |
| `tests/integration/intake/clarification.test.ts` | **14** — rounds against the real catalogue, entity resolution from rows only, creation blocked then allowed, a category inserted at runtime |

### Gates

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **511 tests** |
| `npm run test:integration` | **pass** — **239 tests** |
| `npm run build` | **pass** — compiled in 26.0s |


---

## Phase 12 — Local production rehearsal — **complete**

Exit criterion: *a clean machine can clone, configure env, run Docker, and execute critical
flows.* Each part was executed rather than described.

### The smoke test

`npm run smoke` was declared in `package.json` and the script did not exist — the command
would have failed for anyone who ran it. It exists now, and answers "is this deployment
working?" rather than "did the container start", since a container can be `healthy` and serve
a product nobody can use.

**15 checks, passing against both the native build and the container.** It creates nothing,
changes nothing, and exits non-zero on any failure, so it is usable as a deployment gate.

Every check corresponds to something that has actually failed silently in this build: the
missing standalone assets, the degraded dependency reported as healthy, the unguarded route,
the empty database.

### Restart and failure behaviour — measured

| Scenario | Result |
| --- | --- |
| `docker compose restart web worker postgres redis` | **Recovered** on its own |
| Postgres stopped while the app runs | `/api/health` → **503**; it does not claim to be ok |
| Postgres started again | **Recovered without restarting the application** |
| Dev-only dependency missing in the image | Handled — `pino-pretty` absent, logger falls back to JSON with a warning |

The second and third rows are the ones that matter: a stack that reports itself healthy while
its database is gone is worse than one that is down, and a stack that needs a manual restart
after a blip is an outage every time the database moves.

### Backup and restore — verified, not described

A dump was taken, restored into a scratch database, and the restored rows counted: 390 KB,
6 airports, 27 users, 3 requests, 3 offers — matching the source. The scratch database was
then removed; the working database was never touched.

`docs/OPERATIONS.md` documents the verification step as part of the procedure, because a dump
that restores without error can still be missing what you care about.

### Clean-machine rehearsal

A fresh, empty database was created and taken through the documented path:

```
[migrate] applying 0001_foundation.sql … 0006_pricing.sql
[migrate] done — 6 applied, 0 already present
[seed] 6 airports · 6 services · 17 provider companies · 27 users · 24 vehicles · 18 drivers …
```

Then removed. This proves the documented sequence works from nothing, which is the only thing
that makes `docs/OPERATIONS.md` trustworthy.

### One password, set once

Seeded accounts share a single password so nothing has to be rotated per user, which is what
was asked for. It now comes from `SEED_PASSWORD` and falls back to the development one.

The seed guard was rewritten to follow the actual risk. It used to refuse any non-local
environment; but seeding **is** how a deployed environment gets its airports, its catalogue
and its first administrator, and refusing it outright means doing that by hand. The danger is
seeding one with the password published in this repository — so that is what it now checks. A
deployed environment seeds freely once `SEED_PASSWORD` is set, once, and never again.

### Documentation

`docs/OPERATIONS.md` — clone to running stack, migrations and seed, backup and restore,
restart and failure behaviour, logs, quality gates, and the Windows build-lock gotcha that
cost an hour earlier in this build.

### Gates

| Command | Result |
| --- | --- |
| `npm run lint` | **pass**, 0 problems |
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — **515 tests** |
| `npm run test:integration` | **pass** — **239 tests** |
| `npm run build` | **pass** |
| `docker compose build` | **pass** |
| `npm run smoke` (native) | **pass** — 15/15 |
| `npm run smoke` (container) | **pass** — 15/15 |
| Full verification chain, both runtimes | **pass** — 8/8 each |
