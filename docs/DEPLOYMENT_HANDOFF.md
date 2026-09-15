# Deployment handoff — read this first

Everything a fresh session needs to take Apron from a working local stack to AWS. Written on
**2026-09-15**, at the point where Phases 0–12 are complete and Phase 13 has not started.

Read alongside:

- **`CLAUDE.md`** — the contract. §3 names the production target, §27 the seeded-account
  policy, §31 the phases. It is current; every decision below is already reflected in it.
- **`docs/OPERATIONS.md`** — how to run, migrate, seed, back up, restore, and what fails how.
- **`docs/DECISIONS.md`** — 20 ADRs. ADR-015 (no cost tracking) and ADR-020 (one environment,
  no email) are the two that constrain the infrastructure.
- **`docs/BUILD_STATUS.md`** — what each phase delivered and what its gates measured.

---

## 1. Where the build actually is

**Phases 0–12 complete.** Phase 13 (AWS Terraform) is the only one left and has not started.

Measured at handoff, not estimated:

| Gate | Result |
| --- | --- |
| `npm run lint` | pass, 0 problems |
| `npm run typecheck` | pass |
| `npm test` | **515 tests** |
| `npm run test:integration` | **239 tests**, against a real PostgreSQL |
| `npm run build` | pass |
| `docker compose build` | pass |
| `npm run smoke` | **15/15**, against both the native build and the container |
| Routing verification | **340/340**, every role against every route |
| RBAC verification | **33/33**, cross-tenant isolation from the outside |

Running locally: the native standalone build on **3001**, the Docker stack on **53000**
(`web`, `worker`, `postgres`, `redis`, `mailpit`). Both were verified independently — a fix
proven on one server is not proven on the other, which cost real time in this build.

---

## 2. The three decisions that shape the infrastructure

These are settled. Do not reopen them without the owner asking.

### One environment

A **single** deployed stack. Not dev/staging/production tiers. Terraform describes one
target; nothing is parameterised across environments that will not exist. Every such variable
is a place for the deployed stack to differ from the one that was tested.

### No email, and no SES

Amazon SES is **out of scope**. No verified domain, no identity, no bounce handling, no
sandbox exit — none of it belongs in the account.

The deployed environment runs the mail adapter as `MAIL_TRANSPORT=log`, which records what
would have been sent and reports success. **This needs no application change**: notifications
still raise, still write their row, still deduplicate on retry through the unique idempotency
key, and still appear in the notifications centre and on the request. The channel changes;
whether the platform tells anyone does not.

Consequence worth holding onto: anything a person must act on has to be visible **in the
product**. That is already true — the exceptions view, the provider queue ordered by SLA age
and the notifications centre exist precisely because email was never allowed to be the only
way a fact reached someone.

### No AI cost tracking

ADR-015. Nothing computes or stores the monetary cost of a model call. Do not add token
accounting, pricing or cost estimation to dashboards, logs or infrastructure. AI observability
is **reliability only**: latency, fallback rate, schema-failure rate, verification failures.

---

## 3. What the target looks like

From `CLAUDE.md` §3, with SES removed:

- ECS Fargate — **two services**: `web` and `worker`, from the same image
- RDS PostgreSQL
- ElastiCache Redis
- S3 for documents
- CloudFront only if document/static delivery needs it
- Secrets Manager / SSM for secrets
- CloudWatch logs and metrics
- Terraform, in `infra/terraform/`

The worker is not optional. It owns acknowledgement-SLA expiry, re-matching, notification
delivery and document generation. Without it, offers sit unacknowledged forever.

### Configuration the deployed stack needs

| Variable | Note |
| --- | --- |
| `DATABASE_URL` | RDS. The app runs its own migrations; see §5 below. |
| `REDIS_URL` | ElastiCache. |
| `QUEUE_ENABLED=true` | With the worker running. `false` is valid for a single-process deployment and makes matching run inline. |
| `APP_ENV=production` | Gates the seed; see §5. |
| `SEED_PASSWORD` | **From Secrets Manager.** Set once, never rotated. See §5. |
| `MAIL_TRANSPORT=log` | The no-email decision. |
| `LOG_PRETTY` | **Leave unset.** `pino-pretty` is a devDependency and absent from the image. |
| `OPENAI_API_KEY` + the four model variables | Optional — the product works with AI off (Journey E). |
| `SESSION_COOKIE_NAME`, `DOCUMENT_STORAGE_DRIVER`, `RATE_LIMIT_ENABLED` | See `.env.example`. |

`src/lib/config/env.ts` is the single schema. It validates at boot and refuses to start on a
bad value rather than failing later in a request — read it before writing the task
definitions, as it is the authoritative list.

---

## 4. Things that will bite, learned the hard way here

**The image is lean by design.** No `scripts/`, no `tsx`, no devDependencies. Anything the
deployment needs to run — migrations, seed — must be reachable from the production image or
run as a separate task from a build-time image.

**`pino-pretty` is not in the image.** `LOG_PRETTY=true` used to crash *every server action*
inside the container while the identical code worked outside it. It now catches and falls
back to JSON with a warning, but leave the variable unset.

**Next's standalone output omits `.next/static` and `public/`.** `scripts/prepare-standalone.mjs`
copies them in during `npm run build`. A deployment missing this serves a working API and an
unstyled page — healthy in logs, broken to a user. The smoke test checks for it explicitly.

**Health is a real probe.** `/api/health` returns **503** when Postgres or Redis is degraded.
Point the ALB target group and the ECS health check at it; do not substitute a static 200.

**Verify what you deployed, on what you deployed it to.** `npm run smoke`,
`npm run verify:routing` and `npm run verify:rbac` all accept `BASE`. A fix confirmed on one
server proves nothing about another.

---

## 5. Migrations and the first administrator

**Migrations:** hand-written SQL, applied in filename order, each in its own transaction,
recorded in `_apron_migrations` with a checksum (ADR-003). An already-applied file whose
contents changed is a hard error, not a silent divergence. Six migrations at handoff.

Run them as a one-off ECS task before the service starts, or from the container entrypoint.
They are idempotent; running twice applies nothing.

**Seeding is part of deployment, not a local convenience.** It creates the airports, the FBOs,
the service catalogue, the provider network and the first administrator. It is idempotent and
transactional — every insert is an upsert on a natural key, so re-running changes nothing, and
a failure halfway leaves an empty database rather than half a network.

**One password, set once.** Every seeded account shares it, so nothing is rotated per user.
It comes from `SEED_PASSWORD`.

The guard follows the real risk: seeding a non-local `APP_ENV` is refused **while the
fallback development password is still in use**, because that password is published in this
repository. Set `SEED_PASSWORD` in Secrets Manager once and seeding proceeds normally,
forever. Never print a configured one to logs.

---

## 6. What must still work when it is deployed

The seven acceptance journeys in `CLAUDE.md` §32 are the definition of done, and they are
verified against the *real* application, not mocked. Journey E (AI unavailable) and Journey G
(a provider reaching for another provider's data) are the two most likely to be affected by
an infrastructure mistake:

- **Journey E** — with no `OPENAI_API_KEY`, intake must still accept a sentence and offer
  manual completion, and matching must still choose the deterministic top candidate.
- **Journey G** — cross-tenant denial is enforced server-side, and `npm run verify:rbac`
  checks it from the outside. Run it against the deployed environment.

---

## 7. Recent work, for context

The last two pieces of work before handoff, both already merged and verified:

**Plain-language pass.** No internal identifier reaches a user anywhere in the four portals —
`platform_admin` reads as "Platform administrator", `jet_a` as "Jet A". Three surfaces
deliberately keep a raw code as small secondary text (settings keys, service codes, audit
actions) because that string is what the audit trail records; a live sweep
(`scripts/diag-raw-identifiers.ts`) proves the readable label renders beside it.

**Intake clarification.** Intake used to let a request be created while the catalogue said
required fields were missing; confirming then failed inside `createRequest` with the
validator's own words. There is now a generic, configuration-driven clarification engine
(`src/domain/requests/clarification.ts`) that asks for exactly what a service category
declares, in the control its type calls for. A service added from Admin is asked about
correctly with no component written for it — there is a test that inserts one at runtime and
proves it.

Confirmation is gated in two places: the button reads the plan, and the server enforces the
same rule independently, because a disabled button is not a control.

---

## 8. Starting Phase 13

`CLAUDE.md` §31 is explicit: Terraform does not start until the local production flow works
end-to-end. It does — Phase 12 is complete and its gates are in §1 above.

Two things are needed from the owner before the first `terraform apply`:

1. **AWS account and region**, and how credentials will be supplied.
2. **The `SEED_PASSWORD`** for the deployed stack — placed in Secrets Manager by the owner,
   not shared into a chat or committed.

`CLAUDE.md` §36 says it plainly: if account-specific values are unavailable, complete the
Terraform and the deployment documentation as far as they can go without inventing
credentials, then report exactly what input is required to execute the deployment.
