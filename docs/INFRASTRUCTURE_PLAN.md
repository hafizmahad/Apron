# Phase 13 — infrastructure plan

Written **2026-09-16**, before any `terraform apply`. Phases 0–12 are complete and the
repository is on GitHub with CI running. This is the plan the deployment follows; it is
written down first so that what gets built is a decision rather than an accident.

Read alongside `CLAUDE.md` §3 (the production target), `docs/DEPLOYMENT_HANDOFF.md`
(what the application needs from its environment) and `docs/DECISIONS.md` ADR-015 and
ADR-020.

---

## 1. The three constraints that are already settled

Not reopened here. They shape everything below.

**One environment.** A single deployed stack. Not dev/staging/production tiers. Nothing is
parameterised across environments that will not exist, because every such variable is a
place for the deployed stack to differ from the one that was tested.

**No email, and no Amazon SES.** No verified domain, no identity, no bounce handling, no
sandbox exit. The mail adapter runs `MAIL_TRANSPORT=log`, which records what would have
been sent and reports success. Notifications still raise, still write their row, still
deduplicate on retry, and still appear in the notifications centre and on the request. The
channel changes; whether the platform tells anyone does not. **No SES resource appears in
the Terraform.**

**No AI cost tracking.** Nothing computes or stores the monetary cost of a model call. AI
observability is reliability only.

---

## 2. The blocker that has to be decided before anything is built

**With `APP_ENV=production`, the session cookie is issued `secure: true`**
(`src/auth/session.ts:232`). A browser will not store a `Secure` cookie over plain HTTP.

An ALB's own DNS name — `apron-alb-1234.us-east-2.elb.amazonaws.com` — can only serve
plain HTTP, because no public certificate authority will issue a certificate for a name
under `amazonaws.com`.

So over a bare ALB link the failure looks like this: the site loads, the login form
accepts the password, the server creates a real session — and the browser silently
discards the cookie, so the next request is unauthenticated and the user lands back on the
login page. No error, nothing in the logs, unfixable by retrying. Every portal is
unreachable.

This has to be solved before the link is worth sending to anyone. Three ways:

| | How the link looks | TLS | Cost | Needs |
| --- | --- | --- | --- | --- |
| **A. Custom domain** | `apron.yourdomain.com` | ACM certificate on the ALB, free | Route 53 hosted zone ~$0.50/mo | A domain you control |
| **B. CloudFront in front of the ALB** | `d1x2y3.cloudfront.net` | CloudFront's own certificate, free | Request/transfer charges | Nothing |
| **C. Neither** | ALB DNS name | none | — | — |

**C does not work.** It is listed only so it is not chosen by accident.

**A is the right answer** if a domain exists. It is the smaller system, the link is
readable, and `CLAUDE.md` §3 says CloudFront only if needed.

**B is the fallback** when there is no domain, and it is a legitimate use of CloudFront —
terminating TLS so that a shareable link exists at all. The ALB is then locked to
CloudFront's prefix list so nobody reaches the origin directly.

Either way `APP_URL` must be set to the exact public origin, because it is what absolute
links in notifications and documents are built from.

---

## 3. Who can reach it

The ALB is **internet-facing** and its security group allows `0.0.0.0/0` on 443. Anyone
given the link can open it — that is the requirement.

Worth being explicit about what that does and does not mean: reachable is not the same as
open. Every portal route is behind authentication, and `npm run verify:rbac` proves
cross-tenant denial from outside the process. A stranger with the link reaches a login
page, and nothing else. Rate limiting stays on (`RATE_LIMIT_ENABLED=true`), because a
public login form gets found.

Nothing else is public. RDS, ElastiCache and the ECS tasks all sit in private subnets with
security groups that only accept traffic from the security group in front of them.

---

## 4. What gets built

Region **us-east-2 (Ohio)**. Dedicated AWS account.

```
                          internet
                              │
                    [ CloudFront or ACM/ALB ]      ← TLS, decision in §2
                              │
                ┌─────────────▼─────────────┐
                │  ALB  (public subnets)    │       health check: /api/health, matcher 200
                └─────────────┬─────────────┘
                              │ :3000
         ┌────────────────────▼─────────────────────┐
         │        ECS Fargate — private subnets      │
         │   web service          worker service     │   same image, two entrypoints
         └───┬───────────────────────┬──────────────┘
             │                       │
      ┌──────▼──────┐        ┌───────▼────────┐      ┌──────────────┐
      │ RDS Postgres│        │ ElastiCache    │      │  S3 documents │
      │  16, private│        │ Redis 7,private│      │   private     │
      └─────────────┘        └────────────────┘      └──────────────┘
```

| Component | Shape | Why this and not more |
| --- | --- | --- |
| VPC | 2 AZs, 2 public + 2 private subnets, 1 NAT gateway | Two AZs because RDS and the ALB both require it. One NAT, not two: the second buys AZ-failure resilience for outbound traffic at roughly the cost of the database. |
| ALB | internet-facing, 443 → target group :3000, 80 → redirect | Health check is the real `/api/health`, which returns **503** when Postgres or Redis is degraded. Do not substitute a static 200. |
| ECS cluster | Fargate | No EC2 to patch. |
| `web` service | desired 2, 0.5 vCPU / 1 GB | Two tasks so a deployment is not an outage. |
| `worker` service | desired 1, 0.5 vCPU / 1 GB | **Not optional.** It owns acknowledgement-SLA expiry, re-matching, notification delivery and document generation. Without it, offers sit unacknowledged forever. One task because jobs are idempotent but not written to be raced. |
| RDS | PostgreSQL 16, `db.t4g.micro`, 20 GB gp3, encrypted, 7-day backups, single-AZ | One environment, and Multi-AZ doubles the largest line on the bill. Backups and a documented restore are the recovery story. |
| ElastiCache | Redis 7, `cache.t4g.micro`, single node | Queue transport. A lost node loses in-flight jobs, which retry. |
| S3 | one private bucket, SSE-S3, versioned, public access blocked | `DOCUMENT_STORAGE_DRIVER=s3`. |
| Secrets Manager | `apron/*` | §5. |
| ECR | `apron/web`, `apron/worker`, scan-on-push, lifecycle keeps 20 | |
| CloudWatch | `/ecs/apron-web`, `/ecs/apron-worker`, 30-day retention | Logs are JSON; `LOG_PRETTY` stays unset. |
| IAM | GitHub OIDC provider + `apron-github-deploy` role | §7. No long-lived access key in GitHub. |

**Not built:** SES, Multi-AZ RDS, a second NAT, autoscaling policies, WAF, Route 53 unless
a domain is used, pgvector, DynamoDB.

---

## 5. Configuration and secrets

`src/lib/config/env.ts` is the authoritative schema; it validates at boot and refuses to
start on a bad value. Task definitions are written from it, not from memory.

**Secrets Manager** (injected as ECS `secrets`, never as plain environment):

| Secret | Note |
| --- | --- |
| `apron/database-url` | Written from the RDS module output. |
| `apron/session-secret` | 48 random bytes, generated once. |
| `apron/seed-password` | **Placed by the owner.** Never in a file, never in a chat. |
| `apron/openai-api-key` | Optional — the product works with AI off. |

**Plain environment:** `APP_ENV=production`, `APP_URL` (the public origin from §2),
`PORT=3000`, `REDIS_URL`, `QUEUE_ENABLED=true`, `MAIL_TRANSPORT=log`,
`DOCUMENT_STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION=us-east-2`,
`RATE_LIMIT_ENABLED=true`, `DATABASE_SSL=true`.

**`LOG_PRETTY` is not set at all.** `pino-pretty` is a devDependency and absent from the
image by design.

---

## 6. Migrations and the first administrator

Both run as **one-off ECS tasks using the worker image** with a command override. The
image now carries working entrypoints for both — `dist-worker/migrate.js` and
`dist-worker/seed.js` — which it did not until the argon2 externalisation fix; the seed
failed in the image at the first password hash, which is the step that creates the first
administrator.

```
aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"worker","command":["node","dist-worker/migrate.js"]}]}'
aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"worker","command":["node","dist-worker/seed.js"]}]}'
```

Migrations are applied in filename order, each in its own transaction, recorded with a
checksum; an already-applied file whose contents changed is a hard error. Running twice
applies nothing. The seed is idempotent and transactional — every insert upserts on a
natural key, and a failure halfway leaves an empty database rather than half a network.

Seeding a non-local `APP_ENV` is refused while the fallback development password is still
in use, because that password is published in this repository. `apron/seed-password` set
once, in Secrets Manager, and it never needs changing.

---

## 7. Deployment pipeline

`deploy.yml` was deliberately not written until now, because it assumes a role whose trust
policy names this exact repository, and that role comes from the Terraform.

GitHub OIDC → `apron-github-deploy`, trust scoped to `repo:hafizmahad/Apron:ref:refs/heads/main`.
On a green `main` (auto-deploy, as chosen):

1. build both image targets, push to ECR tagged with the commit SHA
2. register new task definitions
3. run the migration task, **wait for exit code 0**
4. update the `web` and `worker` services, wait for stability
5. run `npm run smoke`, `verify:routing` and `verify:rbac` against the public URL
6. fail the workflow if any of them fail

Step 5 is the point. A deployment that has not been verified against the thing it
deployed to has not been verified.

---

## 8. Order of operations

| # | Step | Verified by |
| --- | --- | --- |
| 1 | Bootstrap: S3 state bucket, versioned, encrypted, public access blocked. Native S3 locking (Terraform ≥ 1.10), no DynamoDB table. | `terraform init` |
| 2 | Network: VPC, subnets, routes, NAT, security groups | `terraform plan` reviewed line by line |
| 3 | Data: RDS, ElastiCache, S3, Secrets Manager | connect from a one-off task |
| 4 | ECR, and push the first image by hand | `aws ecr describe-images` |
| 5 | TLS decision from §2 built | certificate issued and validated |
| 6 | ALB, target group, listeners | target group healthy |
| 7 | ECS cluster, task definitions, both services | tasks running, ALB healthy |
| 8 | Migration task, then seed task | row counts reported by the seed |
| 9 | Verify against the public URL | smoke 15/15, routing 340/340, RBAC 33/33 |
| 10 | Acceptance journeys A–G by hand | `CLAUDE.md` §32 |
| 11 | `deploy.yml` wired to the OIDC role | one deployment through the pipeline |

Nothing is marked done on a `terraform apply` exiting 0. It is marked done when the thing
it built answers.

---

## 9. Risks, and what is done about each

| Risk | Mitigation |
| --- | --- |
| **Secure cookie over plain HTTP — nobody can log in** | §2. Decided before anything is built, not discovered at step 9. |
| Health check passes while the app is broken | The ALB check is the real `/api/health`, which 503s on a degraded dependency. |
| Standalone build missing `.next/static` / `public` | CI asserts their presence; smoke checks a stylesheet and an image over HTTP. |
| Worker not deployed, offers never expire | The worker is a service in the same Terraform, not a manual step. Its absence is a failed plan. |
| Migration task fails and the deploy continues | The pipeline waits for exit 0 before updating services. |
| Seed refuses on a deployed environment | Expected until `apron/seed-password` exists. Documented in §6, and a clear error rather than a silent half-seed. |
| Secrets in logs or task definition | Injected as ECS `secrets` from Secrets Manager. `AI_STORE_PROMPT_BODIES=false`. |
| Cost drifting upward unnoticed | Smallest instance classes, single-AZ, one NAT, 30-day log retention, ECR lifecycle policy. A budget alarm is the one alarm worth having on day one. |
| Terraform state lost or raced | S3, versioned, encrypted, with native locking. |
| Image carries code it never runs | Already fixed: prod-only dependencies in the worker image, npm removed, base packages upgraded. Trivy: zero HIGH/CRITICAL. |

---

## 10. Still needed from the owner

1. **The AWS account id** for Apron, once the member account exists, and credentials for it.
2. **The TLS decision in §2** — a domain, or CloudFront. This one gates a working login.
3. **`apron/seed-password`** in Secrets Manager, placed by the owner.
4. **Permission to install Terraform** on the build machine (≥ 1.10, for S3 native locking).

Items 1 and 2 block the first apply. Item 3 blocks step 8 only. Item 4 blocks everything
and is a one-line install.
