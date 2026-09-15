# Running Apron

Everything needed to take this from a clone to a working stack, and to keep it working.
Every command here was run against this repository and the results are the ones recorded.

---

## From a clean machine

Requirements: Docker Desktop and Node 22+. Nothing else.

```bash
git clone <repository> apron && cd apron
cp .env.example .env          # then set OPENAI_API_KEY if you want AI; it runs without one
docker compose up -d          # postgres, redis, mailpit, web, worker
```

The entrypoint migrates and seeds before the application accepts traffic, so there is no
separate setup step. When it settles:

```bash
npm run smoke                 # against http://127.0.0.1:3001
BASE=http://127.0.0.1:53000 npm run smoke   # against the container
```

**The smoke test is the answer to "is this working?"** — not the container's status. A
container can be `healthy` and serve a product nobody can use.

```
 PASS  application responds           HTTP 200
 PASS  dependencies healthy           {"database":{"status":"ok","latencyMs":3},"redis":{"status":"ok","latencyMs":2}}
 PASS  page renders                   13901 bytes
 PASS  stylesheet served              /_next/static/css/… → HTTP 200
 PASS  public assets served           service imagery → HTTP 200
 PASS  private routes guarded         /ops/requests → HTTP 307
 PASS  sign-in works                  ops.manager@apron.local
 PASS  authenticated page renders     /ops/requests → HTTP 200
 PASS  seeded: airports               6 rows
 PASS  seeded: provider_companies     17 rows
 PASS  seeded: service_categories     6 rows
 PASS  seeded: users                  27 rows
 PASS  migrations applied             6 migrations recorded
 PASS  queue configured               enabled
 PASS  AI configuration               enabled — intake gpt-4.1-mini, matching gpt-4.1
all 15 checks passed
```

It creates nothing and changes nothing. It exits non-zero on any failure, so it is usable as
a deployment gate.

### Why it checks what it checks

Each of these has failed in this build at least once, silently:

| Check | The failure it catches |
| --- | --- |
| stylesheet, public assets | Next's standalone output omits `.next/static` and `public/`. The API works, the page is unstyled, and the logs look healthy. |
| dependencies healthy | `/api/health` returns **503** when Postgres or Redis is degraded, so this is a dependency probe rather than a liveness ping. |
| private routes guarded | A deployment serving an operations page to nobody in particular is worse than one that is down. |
| sign-in works | Exercises argon2id and the session store together — configuration that nothing else notices is wrong until a person tries to log in. |
| seeded rows | An empty database is the most common way a fresh deployment is "up" and useless. |

---

## Migrations and seed

```bash
npm run db:migrate     # apply pending migrations
npm run db:seed        # reference network: airports, FBOs, catalogue, providers, users
npm run db:scenarios   # live requests moving through the lifecycle (optional)
npm run db:reset       # drop, migrate, seed — destroys everything
```

**Migrations** are hand-written SQL applied in filename order, each in its own transaction,
recorded in `_apron_migrations` with a checksum. A migration whose contents changed after
being applied is a hard error rather than a silent divergence (ADR-003).

**The seed is idempotent and transactional.** Every insert is an upsert on a natural key
(ICAO, slug, email, plate), so running it twice changes nothing — it is safe in an entrypoint
and safe to re-run after adding reference data. A failure halfway leaves an empty database
rather than half a network.

**`db:scenarios` refuses to run twice**, by looking for its own marker request. It creates
requests by calling the same services the product uses — never by inserting rows — so every
status, offer and assignment it produces is one the state machines actually made.

### The seeded password

Every seeded account signs in with one password, so nothing has to be rotated per user.

- Unset, it is the development password printed by the seed. Fine locally.
- `SEED_PASSWORD` overrides it. **Set it once for a deployed environment and it never needs
  changing again.**

Seeding a non-local `APP_ENV` is refused *while the password is still the development one* —
the risk is not seeding a remote environment (that is how it gets its airports and its first
administrator), it is seeding one with a password published in this repository.

---

## Backing up and restoring

Verified on this stack, not merely documented:

```bash
# Back up — 390 KB for the seeded network plus scenarios
docker exec apron-production-postgres-1 pg_dump -U apron -d apron -Fc > apron-backup.dump

# Restore into a scratch database first, and check it before trusting it
docker exec apron-production-postgres-1 psql -U apron -d postgres -c "create database apron_check;"
docker exec -i apron-production-postgres-1 pg_restore -U apron -d apron_check < apron-backup.dump
docker exec apron-production-postgres-1 psql -U apron -d apron_check -c \
  "select (select count(*) from airports) airports, (select count(*) from users) users,
          (select count(*) from requests) requests, (select count(*) from provider_offers) offers;"
```

The verification step is the point. A dump that restores without error can still be missing
what you care about; counting rows you recognise takes seconds and is the difference between
having a backup and believing you have one.

Restoring over the live database:

```bash
docker compose stop web worker          # nothing should be writing during a restore
docker exec -i apron-production-postgres-1 pg_restore -U apron -d apron --clean --if-exists < apron-backup.dump
docker compose start web worker
BASE=http://127.0.0.1:53000 npm run smoke
```

`pg_dump -Fc` writes the custom format, which `pg_restore` can read selectively and in
parallel. Plain SQL (`-Fp`) is fine too and easier to read, but cannot be restored table by
table.

**The Docker volumes hold the data.** `docker compose down` keeps them; `docker compose down
-v` destroys them, which is how a local database is lost. Take a dump first.

---

## Restart and failure behaviour

Measured on this stack:

| Scenario | Result |
| --- | --- |
| `docker compose restart web worker postgres redis` | **Recovered.** The stack returns to healthy on its own. |
| Postgres stopped while the app runs | `/api/health` returns **503**. It does not claim to be ok. |
| Postgres started again | **Recovered without restarting the application.** The pool reconnects. |
| Worker restarted mid-flight | Jobs are retried from Redis. Bounded attempts, then a dead letter. |

Two properties this depends on, both deliberate:

**Jobs are idempotent.** A notification carries a unique idempotency key, enforced by a
UNIQUE index on `notification_deliveries`. A retried job cannot send a second email or raise
a second notification — the second insert loses to the constraint.

**The SLA does not depend on a delayed message surviving.** A periodic sweep re-checks for
offers past their acknowledgement deadline, so a Redis restart or a deploy that drops a
scheduled job cannot leave an offer hanging forever. The delayed message is the fast path;
the sweep is the guarantee.

### If the queue is unavailable

`QUEUE_ENABLED=false` is a supported configuration, not a degraded one: matching runs inline
in the request that created it. It is how a single-process deployment runs. The smoke test
reports which mode is in effect rather than treating either as an error.

---

## Logs

Structured JSON with a correlation id threaded through every line, so one request or job can
be followed across the web and worker containers.

```bash
docker compose logs -f web worker
docker compose logs web | grep '"level":"error"'
```

`LOG_PRETTY=true` asks for human-readable output, and it works in exactly one place:

| Where | `pino-pretty` present? |
| --- | --- |
| `npm run dev`, and the `tsx` scripts | yes |
| The standalone build (`npm run build`) | **no** |
| The container | **no** |

It is a devDependency, and neither the standalone output nor the production image carries
one. So `LOG_PRETTY=true` in either of those produces a warning on every boot and JSON
anyway:

```
LOG_PRETTY is set but pino-pretty is not installed — falling back to JSON logs
```

The fallback exists because the crash it replaced took down **every server action** in the
container while the same code worked perfectly outside it. It is a safety net, not the fix.

The fix is not to set it where it cannot work. `docker-compose.yml` pins `LOG_PRETTY: "false"`
rather than inheriting it, because Compose fills `${VAR}` from `.env` — where a developer
reasonably sets it for the dev server — and that setting would otherwise follow them into a
container. Leave it false in any deployed environment: JSON is what a log aggregator reads.

---

## A gotcha that costs an hour

**Stop the standalone server before building.** It runs from inside `.next/standalone`, and
Windows locks a running executable's files, so `next build` blocks — silently, with no error
and no output. It looks like a very slow build.

```bash
# A build that is working climbs in CPU and memory. One that is blocked does not.
npm run build          # after stopping the server: ~12-26 seconds
```

The same build that sat for 24 minutes with 50 seconds of CPU completed in 11.9 seconds once
the server was stopped. The container path cannot hit this, because it builds into its own
image with nothing executing from the output directory.

---

## Quality gates

```bash
npm run lint
npm run typecheck
npm test                  # 515 unit tests
npm run test:integration  # 239 tests against a real PostgreSQL
npm run build
docker compose build
npm run smoke
```

There is deliberately no screenshot, video or visual-regression tooling (CLAUDE.md §34).
Correctness is proved by domain tests, database constraint tests, RBAC tests, queue and
idempotency tests, AI evals and the smoke check — not by comparing images.

### Verifying a running deployment

```bash
npm run verify:routing    # every role against every route
npm run verify:rbac       # cross-tenant isolation, from the outside
```

Both accept `BASE`, so they can be pointed at the container or at a deployed environment.

---

## Accounts

Seeded accounts cover every role. All of them use the one seeded password.

| Portal | Account |
| --- | --- |
| Admin | `admin@apron.local` |
| Operations | `ops.manager@apron.local`, `ops.agent@apron.local` |
| Provider | `dispatch@hudsonexec.example` and one per provider company |
| Client | `aviation@meridiancapital.example` |

These are seed data for a local stack. Nothing in the product depends on them existing, and
they are never shown in the interface.
