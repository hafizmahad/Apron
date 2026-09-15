# Apron Production — Architectural Decisions

Format: `ADR-NNN — title` / Status / Context / Decision / Consequences.
Decisions are append-only. Superseding entries reference the ADR they replace.

---

## ADR-001 — Single modular Next.js application plus a separate worker process
**Status:** accepted (Phase 0)

**Context.** `CLAUDE.md` §33 forbids premature microservices and requires an explicit
queue/worker layer. The platform needs acknowledgement-timeout handling, re-match,
notifications and document generation to run outside the request/response cycle.

**Decision.** One Next.js 15 App Router application (`src/app`) sharing a single `src/`
module tree with a standalone worker entrypoint (`src/jobs/worker.ts`) executed as a
second container in Docker Compose. Both processes import the same domain, persistence
and AI modules; neither duplicates business logic.

**Consequences.** One build, one migration path, one type system. Horizontal scaling is
per-process (ECS service for web, ECS service for worker) without any code change.

---

## ADR-002 — PostgreSQL is the source of truth for integrity, not application code
**Status:** accepted (Phase 0)

**Context.** §30 requires that correctness not depend on UI affordances, and §6 requires
that overlapping resource assignments be impossible.

**Decision.** Critical invariants are expressed as database constraints: foreign keys,
unique indexes, check constraints and `EXCLUDE USING gist` constraints over
`tstzrange(start_utc, end_utc, '[)')` for every concretely assignable resource. The
`btree_gist` extension is enabled in the first migration. Application-level checks exist
for good error messages only; they are never the sole guard.

**Consequences.** Concurrent double-booking raises a constraint violation which the
assignment service maps to a typed domain error. Tests assert the constraint, not the
service.

---

## ADR-003 — Drizzle ORM with hand-authored SQL migrations committed to the repo
**Status:** accepted (Phase 0)

**Context.** §3 requires Drizzle plus SQL migrations in version control. Exclusion
constraints, partial unique indexes and generated columns are not fully expressible in
the Drizzle schema DSL.

**Decision.** SQL migration files under `src/db/migrations/` are the artifact of record
and are applied by a small deterministic runner (`src/db/migrate.ts`) that records
applied filenames in `_apron_migrations`. `src/db/schema/*` remains the typed query
surface; an integration test diffs the live database catalog against the TypeScript
schema so the two can never silently drift.

**Consequences.** Migrations are reviewable, ordinary SQL. No dependency on a generator
at deploy time.

---

## ADR-004 — `node-postgres` (`pg`) as the driver
**Status:** accepted (Phase 0)

**Context.** Both the web process and the worker need pooling; the assignment path needs
explicit transactions with row locks.

**Decision.** `pg` with a shared `Pool`, wrapped by `drizzle-orm/node-postgres`.

**Consequences.** No edge-runtime database access. All database work runs on the Node.js
runtime.

---

## ADR-005 — One time module owns every timezone conversion
**Status:** accepted (Phase 0)

**Context.** §7 forbids hand-rolled timezone conversion scattered through the codebase
and requires DST gap/ambiguity to force explicit user confirmation.

**Decision.** `src/lib/time/` is the only module permitted to import Luxon or construct
zoned datetimes. It exposes `resolveLocalWallTime(wall, zone)` which returns a
discriminated union `{ kind: 'ok' | 'ambiguous' | 'nonexistent' }` by probing the zone's
UTC offset on both sides of the wall time and keeping only offsets that round-trip. A
source-boundary test fails the build if `luxon` is imported anywhere outside
`src/lib/time/`.

**Consequences.** Spring-forward and fall-back local times cannot be silently coerced;
intake surfaces an explicit choice to the user. Instants are stored as `timestamptz`
(UTC) and rendered in the airport's `timezone_iana`.

---

## ADR-006 — Argon2id for password hashing, server-side opaque sessions
**Status:** accepted (Phase 0)

**Context.** §27 requires modern password hashing and server-side sessions.

**Decision.** Argon2id behind `src/auth/password.ts`. Sessions are random 256-bit opaque
tokens stored hashed (SHA-256) in `sessions`; the cookie is `HttpOnly`, `SameSite=Lax`,
`Secure` outside development. No JWTs, so revocation is immediate.

**Consequences.** If a platform lacks an argon2 prebuilt binary, only `password.ts`
changes: a Node built-in `scrypt` implementation lives behind the same interface and is
selected by `PASSWORD_HASH_ALGO`.

---

## ADR-007 — AI is a narrow adapter; the model never writes state
**Status:** accepted (Phase 0)

**Context.** §2, §10, §23, §25.

**Decision.** `src/ai/client/` exposes one function shape —
`runStructured({ stage, promptId, schema, input })` → `{ data, usage }` — implemented by
an OpenAI Responses API adapter and a deterministic scripted adapter used by tests and
evals. Product code depends only on the interface. `AI_ENABLED` defaults to `false`; with
no key the adapter reports unavailable and every caller takes its deterministic path.
Source-boundary tests assert that no module under `src/ai/` imports a mutation helper.

**Consequences.** Adding a second provider is a new adapter file. Running offline is a
first-class mode, not a mock.

---

## ADR-008 — Service catalogue is data, not an enum
**Status:** accepted (Phase 0)

**Context.** §6 requires that Admin add a service without a migration.

**Decision.** `service_categories` is a table with `code`, `assignment_strategy` and a
`config_schema_json` describing the per-service requirement fields. Request service lines
store `requirements_json` validated at runtime against the category's schema. The initial
six services are seed rows. Per-service eligibility rules are registered in a typed
registry keyed by `assignment_strategy`, so a brand-new category falls back to the
generic coverage/capacity rules until a strategy is implemented for it.

**Consequences.** No `service_category` Postgres enum anywhere. Adding "de-icing" from
Admin works immediately with generic rules.

---

## ADR-009 — Deterministic eligibility engine is pure and shared with the evals
**Status:** accepted (Phase 0)

**Context.** §9, §26 — "the production oracle and eval oracle must call the same
functions".

**Decision.** `src/domain/matching/` contains only pure functions over explicit immutable
snapshots: no database imports, no `Date.now()`, no randomness. Callers load data, build
a snapshot, evaluate, then persist. Evals import the same functions.

**Consequences.** Property-based tests with `fast-check` cover the whole engine. A
source-boundary test forbids `src/db` and `src/ai` imports inside `src/domain/matching/`.

---

## ADR-010 — Money as integer minor units
**Status:** accepted (Phase 0)

**Context.** §20 — all arithmetic is deterministic; the LLM may explain but not compute.

**Decision.** Monetary amounts are integer minor units plus an ISO-4217 currency code.
`src/lib/money/` owns every arithmetic and rounding operation. No floats.

---

## ADR-011 — Map provider abstracted; static projection is the default adapter
**Status:** accepted (Phase 0)

**Context.** §17 — the map must be useful, not decorative, with no fabricated
coordinates, and the provider must be abstracted behind a client component/config.

**Decision.** `MapCard` renders through an adapter selected by `NEXT_PUBLIC_MAP_PROVIDER`.
The default `static` adapter projects the real stored `latitude`/`longitude` of airports,
FBOs and endpoints onto the supplied abstract map artwork with an equirectangular
projection, and links out to an external map URL. A `maplibre` adapter is used when
`NEXT_PUBLIC_MAP_STYLE_URL` is configured. No coordinate is ever synthesised; records
without coordinates render an explicit "no coordinates on record" state.

---

## ADR-012 — Asset pack is ingested verbatim behind one typed registry
**Status:** accepted (Phase 0)

**Context.** `CLAUDE.md` §21 "Production asset pack", `CLAUDE_INITIAL_PROMPT.md`.

**Decision.** `apron-production-assets/` is copied unmodified to `public/assets/apron/`
with original folder and file names. `src/lib/assets.ts` is the single typed registry; a
test asserts that every path in the registry exists on disk and that no component
contains a literal `/assets/apron/` string. `lucide-react` is the only generic icon
library. Domain SVGs are rendered through `<DomainIcon />`, which inlines the pack SVG so
`currentColor` resolves against design tokens.

**Consequences.** `10_misc/ui-reference.png` and `10_misc/asset-pack-preview.png` are
deliberately absent from the registry and are never rendered as product content.

---

## ADR-013 — Design tokens derive from the supplied pack, expressed as Tailwind v4 theme
**Status:** accepted (Phase 0)

**Context.** §21 requires semantic tokens rather than scattered hex values; the supplied
`DESIGN_TOKENS.css` and `10_misc/ui-reference.png` are the visual north star, and the
user's explicit instruction is that no invented design direction may override them.

**Decision.** The pack's palette is adopted as the primitive layer and re-expressed as
semantic Tailwind v4 `@theme` tokens (`canvas`, `surface`, `elevated`, `sidebar`,
`text-primary`, `text-secondary`, `border`, `accent`, `accent-strong`, `success`,
`warning`, `danger`, `info`). Component styling references semantic tokens only.

---

## ADR-014 — No screenshot/video/visual-regression testing
**Status:** accepted (Phase 0)

**Context.** `CLAUDE.md` §3 "Explicit testing constraint" and §34.

**Decision.** Vitest for unit/property/integration/contract/eval suites, a non-recording
HTTP smoke script for the built application, and manual product verification. No
Playwright, Cypress, screenshot baselines, video capture or trace artifacts anywhere in
the repository or CI.

---

## ADR-015 — No AI token accounting or cost estimation anywhere in the product
**Status:** accepted (Phase 0) — supersedes the cost-tracking clauses of the original
`CLAUDE.md` §14, §23, §26 and §34, which were amended in the contract on the user's
explicit instruction.

**Context.** The original contract required an AI usage/cost dashboard, per-call token
counts, an `estimatedCostUsd` field and a central token-pricing configuration file. The
product owner removed that requirement outright: Apron is not to model, compute, store or
display the monetary cost of a model call.

**Decision.**
- The AI adapter's `usage` payload carries `{ provider, model, latencyMs }` and nothing
  else. There is no `inputTokens`, no `outputTokens`, no `estimatedCostUsd`.
- No token-pricing table, no pricing configuration file, no cost arithmetic.
- The `ai_calls` table records stage, prompt id and version, model, latency, validation
  status, verification status, error category, actor and correlation id — the fields
  needed to diagnose a failure — and has no cost or token columns.
- The Admin AI console reports reliability only: calls per day by stage, latency
  distribution, fallback rate, schema-failure rate, `verified=false` rate, intake
  confidence distribution and top error reason codes.
- Eval suites report accuracy, hallucination rate, validity, fallback rate and latency.
  They do not report cost.

**Consequences.** Nothing in the system depends on a vendor price list, so no price change
can make the platform's numbers wrong. Operational and safety visibility is unaffected:
every failure path (unavailable, malformed output, verification failure, deterministic
fallback) is still recorded and surfaced, which is what §22 and §28 actually require.

Reversible: reinstating cost would mean one additive migration and one adapter field.
Note this decision is *not* about the commercial layer — provider rate cards, quotes and
service pricing (CLAUDE.md §20) are unaffected and remain deterministic integer money.

---

## ADR-016 — Notification idempotency belongs to the database, not the queue

**Status.** Accepted (Phase 10).

**Context.** CLAUDE.md §18 requires that a job retry must never produce a duplicate
notification. BullMQ deduplicates on a custom job id, which handles the ordinary case of a
handler being re-run.

**Decision.** The job id is the first line of defence, and the authority is a UNIQUE index
on `notification_deliveries.idempotency_key`. Inserting the delivery row is the *claim* on
sending the message: `on conflict do nothing` returning no row means another caller already
owns it, and the transport is never contacted.

The key is derived only from facts that do not change between a job and its retry — event
kind, the entity it concerns, the recipient, the channel. Never a timestamp, never a random
value, or the retry would look like a new message.

**Why not rely on the queue.** A queue's deduplication lives in Redis. A flush, a worker
restart, a deploy mid-job, or running with `QUEUE_ENABLED=false` all lose it. The database
row survives all four, and those are precisely the conditions under which a duplicate
notification actually escapes.

**Consequences.** The same event can be emitted from anywhere — inline, from a worker, from
a manual replay — and reach a recipient exactly once. Notification delivery is also
observable as data rather than as queue internals: a failed send is a row with a reason,
which the periodic sweep retries under a bounded attempt count.

Related: in-app notification rows are written separately from delivery rows, so a person
sees a notification in the product whether or not the email ever left the building.

---

## ADR-017 — Operational PDFs are written by hand, with no PDF dependency

**Status.** Accepted (Phase 10).

**Context.** CLAUDE.md §19 requires operational documents — client confirmation, provider
work order, handling summary — and §33 requires that a new dependency be justified.

**Decision.** `src/lib/documents/pdf.ts` emits PDF 1.4 directly: Helvetica from the format's
base-14 fonts, a laid-out line model, automatic pagination, and a correct cross-reference
table. About two hundred lines, no new package.

**Rationale.** Every document this platform produces is typeset text — headings, labelled
rows, a list of services. That is exactly what the base-14 fonts exist for. A PDF library
brings a font pipeline, a layout engine and a large transitive tree to do something the
format already does, and it would have to be audited and kept current for the life of the
product.

**Limits, stated deliberately.** No images, no embedded fonts, no non-Latin text.
Characters outside WinAnsi are transliterated (`—` to `-`, `…` to `...`) and anything with
no stand-in becomes `?`, because a byte above 255 in a PDF literal produces a corrupt file.
If a document ever genuinely needs an image or a non-Latin script, that is the moment to
adopt a typesetting library — not before.

**Consequences.** Correctness is verified structurally rather than assumed: the tests check
that xref offsets point at their objects, that parentheses and backslashes are escaped, that
long content paginates, and that nothing above 0xFF reaches the file. A document a reader
refuses is indistinguishable from no document at the moment somebody needs it, so the
structure is tested, not the fact that bytes were produced.

---

## ADR-018 — Model-facing schemas are shaped by the provider's constraints, not the domain's

**Status.** Accepted (Phase 11).

**Context.** OpenAI's strict structured outputs require every object in a JSON schema to
declare its properties up front, list all of them in `required`, and set
`additionalProperties: false`. An open-ended map — `z.record()` — cannot be expressed at
all. The intake schema needed exactly that: per-service requirement fields, which are
per-category and admin-definable (ADR-008), so there is no fixed list to declare.

This was not discovered by reasoning about it. `intakeServiceSchema.requirements` was a
`z.record()`, the provider answered **400 Invalid schema**, the adapter degraded as designed,
and intake fell back to the deterministic extractor on every single call without anything
failing. The first eval run against a real key found it.

**Decision.** Where a domain shape cannot be expressed in a strict schema, the **wire format**
changes and the domain does not. `requirements` is sent as an array of `{ key, value }` pairs
and a Zod `.transform()` folds it back into a record on the way in. `PromptDefinition` pins
the parsed output type and leaves the input type open, so a schema may transform.

**Consequences.**
- The domain still works with a record. Nothing outside `src/ai/intake/schema.ts` knows the
  wire format differs, and `toWireExtraction` is exported for anything that must produce one.
- `enforceStrict` **throws** on an open-ended object rather than emitting a schema the
  provider will reject, with a message naming the construct and the fix.
- `tests/unit/ai/prompt-schemas.test.ts` converts every registered prompt offline and checks
  it against the published strict-mode rules, so this class of failure is now a unit test
  rather than a silent production degradation.

**The general lesson.** A safe fallback hides the failure it is protecting against. The
adapter degrading on a 400 was correct behaviour; the problem was that nothing measured
whether the primary path was ever taken. Evals against a real key are not optional polish —
they are the only thing that distinguishes "the fallback is working" from "only the fallback
is working".

---

## ADR-019 — Eval thresholds are regression guards against measured baselines

**Status.** Accepted (Phase 11).

**Context.** An eval assertion needs a number. Two tempting choices are both wrong: an
aspirational number makes the suite fail for reasons nobody will act on, and a number chosen
after the fact to make the run pass measures nothing at all.

**Decision.** Two kinds of threshold, and the difference is stated in the suite:

1. **Product requirements**, which are absolute and do not move. The hallucination rate is
   zero — not "low" — because inventing an airport is the failure §8 exists to prevent.
   Matching validity is every answered call, because a provider that was never on the
   shortlist is not a worse choice but no choice. Every request for an action is refused.

2. **Regression guards**, set just under what the system actually measured, with the
   measurement, its date and the prompt version recorded in a comment beside them. The
   margin is for model non-determinism, not for slippage.

**Consequences.** A guard that trips means something changed — a prompt edit, a model
revision, a corpus addition. The response is to investigate and, if the change was an
improvement, re-measure and raise the guard. Lowering one to make a run pass is the move
this ADR exists to forbid.

When an eval case and the product disagree, the question "which is wrong?" is asked
explicitly. Two groups of intake cases turned out to encode an expectation the product
deliberately rejects — "hotel for nine" is an ambiguity, not a quantity — and the *cases*
were corrected. Prompt v1.1.0, by contrast, was a genuine product improvement, and the
before/after numbers for it are recorded in `docs/BUILD_STATUS.md`.


---

## ADR-020 — One environment, and no email from it

**Status:** accepted · **Date:** 2026-09-15

### Context

The deployment target was written as a conventional AWS stack including SES for outbound
mail. Two things about it were never true of this product:

1. There is **one** environment, not a dev/staging/production ladder. Terraform parameterised
   across tiers that will not exist is cost without benefit, and every such variable is a
   place for the deployed stack to differ from the one that was tested.
2. Nobody wants email from it. SES is not free of consequence: it needs a verified domain,
   an identity, a sending reputation, bounce and complaint handling, and a move out of the
   sandbox. All of that is real operational surface for a channel the product is not using.

### Decision

**A single environment.** Terraform describes one stack. No workspace-per-tier, no
environment matrix.

**No SES, and no outbound mail infrastructure of any kind.** The deployed environment runs
the mail adapter as `MAIL_TRANSPORT=log`.

### What this does not change

Notifications remain a first-class part of the product (CLAUDE.md §18). Every event still
raises a notification, still writes its row, still deduplicates on retry through the unique
idempotency key, and still appears in the notifications centre and on the request. The
adapter boundary stays exactly where it is.

What changes is one enum value in configuration. The `log` transport records what would have
been sent and reports success, so the calling code, the queue handlers and their tests are
untouched — **no application code changes for this decision at all**, which is the point of
having had the abstraction.

### Consequences

- Adding email later is a Terraform change plus `MAIL_TRANSPORT=smtp`, not a rewrite.
- Until then, anything a person must act on has to be visible **in the product**. That is
  already true — the exceptions view, the provider queue ordered by SLA age, and the
  notifications centre exist precisely because email was never allowed to be the only way a
  fact reached someone.
- The single environment means the local Docker stack is the only rehearsal available for the
  deployed one, which raises rather than lowers the bar on Phase 12.

---

## ADR-021 — CloudFront terminates TLS, because the session cookie requires it

**Status:** accepted · **Date:** 2026-09-16

### Context

The deployed stack needs an address a person can be sent. The obvious one is the load
balancer's own name, `apron-alb-….us-east-2.elb.amazonaws.com`.

It does not work, and the way it fails is worth writing down because nothing about it is
visible from the outside.

`sessionCookieOptions()` issues the session cookie `secure: true` for any `APP_ENV` other
than `local` — correct, and the only defensible setting for a deployed environment. A
browser will not store a `Secure` cookie received over plain HTTP. An ALB can only serve
plain HTTP here, because no public certificate authority will issue a certificate for a
name under `amazonaws.com`, and there is no custom domain.

So: the site loads. The login form accepts the password. The server verifies it, creates a
real session row, and sets the cookie. The browser discards it. The next request is
unauthenticated and the user is returned to the login page. No error is raised, nothing
appears in the logs, and retrying does exactly the same thing. Every portal is unreachable,
and the application is behaving correctly throughout.

Three ways out: a custom domain with an ACM certificate on the ALB; CloudFront, which
serves its own `*.cloudfront.net` name under its own certificate; or relaxing the cookie,
which means sending session tokens over plaintext and is not a candidate.

### Decision

**CloudFront in front of the ALB, for TLS.** No domain is owned, and this needs none.

`CLAUDE.md` §3 says "CloudFront only if needed for document/static delivery". This is a
different justification than the one anticipated there — it is needed so that a working
link exists at all — and it is recorded here rather than read into that sentence.

**The distribution is not a page cache.** Every portal route is authenticated and every
page is per-user; caching HTML would serve one operator's request list to another. The
default behaviour uses `Managed-CachingDisabled` with `Managed-AllViewerExceptHostHeader`,
and forwards every method, because each mutation in the product is a server action posting
to the page's own path. Only `/_next/static/*`, whose filenames carry a content hash, and
`/assets/*` are cached.

**The origin hop is closed twice.** The ALB security group admits only CloudFront's managed
`origin-facing` prefix list, and the listener's default action is a flat 403 — traffic
reaches the application only through a rule matching a secret header CloudFront adds and
overwrites, so a viewer cannot forge it. Someone who discovers the ALB's DNS name can
neither connect to it nor bypass CloudFront if they could.

### Consequences

- `APP_URL` is the CloudFront domain. Absolute links in notifications and generated
  documents are built from it, so it has to be what a person actually opens.
- Replacing an asset needs an invalidation of `/assets/*`. `/_next/static/*` never does,
  because those filenames change with their contents.
- Moving to a custom domain later is an ACM certificate in us-east-1, an `aliases` entry
  and one changed block. The `us_east_1` provider alias is already declared for it.
- A CloudFront distribution takes ten to fifteen minutes to deploy or to change. That is a
  property of the first apply, not of a deployment — deployments update ECS services and
  never touch the distribution.

---

## ADR-022 — The pipeline verifies the deployment against the deployment

**Status:** accepted · **Date:** 2026-09-16

### Context

This build repeatedly found that a fix proven on one runtime was not proven on another.
`LOG_PRETTY=true` crashed every server action inside the container while the identical
code worked outside it. Next's standalone output omits `.next/static` and `public/`, so a
deployment missing the copy step serves a working API and an unstyled page — healthy in
every log, broken to every user. And the seed could not run from the container image at
all, because argon2 was bundled rather than external, while it ran perfectly from source.

None of those is visible to a test suite run on a developer's machine, or on a CI runner,
or in a build log. All three are visible to a request made against the thing that was
actually deployed.

### Decision

`deploy.yml` ends by running `npm run smoke`, `npm run verify:routing` and
`npm run verify:rbac` with `BASE` set to the public URL, and fails the workflow if any of
them fails. The deployment is not finished when the services reach a stable state; it is
finished when the deployed application answers correctly.

Two supporting rules follow from the same reasoning:

- **Migrations run before the services are updated, and their exit code is waited on.** A
  deploy that pushed an image expecting a column that does not exist is worse than a deploy
  that did not happen.
- **Image tags are commit SHAs and the ECR repositories are `IMMUTABLE`.** "Which code is
  running" is then answerable from the tag alone, which is the single most useful property
  to have during an incident.

### Consequences

- A deployment takes as long as the verification does. That is the price, and it is small.
- `verify:rbac` runs against production on every deploy, signing in as seeded accounts and
  attempting cross-tenant access. It is read-only and its failures are the ones worth
  waking up for (Journey G).
- The same three commands are what a person runs by hand after a manual change, so there is
  one definition of "it works" rather than two.
