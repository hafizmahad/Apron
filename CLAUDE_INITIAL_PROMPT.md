You are the lead full-stack engineer and AI systems engineer for **Apron Production**.

I need you to build this as a **real production-ready application**, not a clickable demo, prototype, proof of concept, frontend mockup, or collection of dummy screens.

Core workflows must use the real database, real authorization, real domain logic, real background jobs, and real OpenAI integration with deterministic fallbacks.

First, read `CLAUDE.md` completely. Treat it as the project contract.

## Product context

Apron is a private-aviation ground-services coordination platform.

A user can write something like:

> Landing at Teterboro Friday at 3am. We need two cars, three close-protection officers, hotel rooms for nine, catering, fuel, and overnight hangar.

The product must turn that into structured operational data, resolve the real airport/FBO records that exist in our database, determine which approved service providers can actually cover each requested service, reason among **only the eligible choices**, send service lines to providers, let providers acknowledge/decline and assign real resources such as vehicles/drivers, and let Operations manage the whole trip/request.

The important interview requirement is the data hierarchy and traceability:

airport → FBO → service → provider → resource → resource availability

For ground transportation in particular:

airport/FBO → ground transport provider → vehicle → driver → schedule/availability

The system must be able to answer, deterministically, whether the requested service can actually be covered in the requested time window.

## Portals

Build three authenticated operational portals:

1. Operations Portal
2. Service Provider Portal
3. Admin Console

Also build the minimal client-facing request/status experience described in `CLAUDE.md`; treat it as an external experience, not a fourth operational console.

## AI rules

Use **OpenAI** for the initial implementation.

I will provide `OPENAI_API_KEY` later through environment variables. Never hard-code it.

I specifically want good LLM reasoning, but do not let the model become the source of truth.

Use this architecture:

**Natural-language intake**
→ OpenAI structured extraction
→ Zod validation
→ deterministic airport/FBO/service resolution
→ user read-back/confirmation

Then:

**Matching**
→ deterministic eligibility check
→ deterministic ranked eligible list
→ OpenAI chooses/reasons among eligible candidates only
→ code verifies the chosen ID
→ deterministic fallback if model output is invalid/unavailable

Then:

**Operations research assistant**
→ read-only request/inventory/trace context
→ read-only tools only
→ no database mutation by the model

The LLM must never calculate authoritative availability, capacity, overlap, opening hours, pricing totals, permissions, or booking state.

No model-generated SQL.
No model-owned writes.
No fabricated provider/resource data.

## Data

Do not use dummy placeholders for the real application path.

You may seed a realistic small dataset so the full system is testable locally, but all screens and workflows must read/write through the real database and real domain logic.

Initial services:
- ground transport
- close protection/bodyguard
- hotel
- catering
- fuel
- hangar

Admin must be able to add another service later without a database migration.

## Design

Use the attached Apron UI reference as the visual direction:

- premium private aviation
- calm and cool
- modern
- dark navy/charcoal side navigation
- bright warm/cool-neutral main surfaces
- restrained burgundy/crimson primary actions
- subtle amber waiting states
- clean typography
- generous whitespace
- polished request cards, tables, timelines, maps, service cards, resource scheduling
- responsive
- accessible
- no generic component-library appearance

Do not copy the screenshot mechanically. Recreate the design language consistently as reusable design tokens/components.

### Production assets

I am also giving you the `apron-production-assets` pack. It is the canonical visual asset pack for this build.

At the beginning of the build:
- inspect the entire asset pack and its `README.md`, `ASSET_MANIFEST.json`, `DESIGN_TOKENS.css`, and UI reference;
- place/preserve it at `public/assets/apron/`;
- create one typed central asset registry such as `src/lib/assets.ts`;
- use `lucide-react` only for ordinary generic UI icons;
- use the custom pack SVGs for aviation/service/resource/domain concepts;
- use the supplied backgrounds and service imagery rather than random remote images;
- never hotlink random third-party image URLs;
- never present a generic fallback image as a real named airport/FBO photograph;
- keep provider placeholder marks only as fallbacks until a real provider logo is uploaded;
- do not render the UI reference or asset-pack preview as product content;
- preserve dark/light contrast and use imagery sparingly so operations screens remain data-first and highly legible.

If you cannot locate the asset pack, ask me where it is, document the expected path, and continue all non-asset-dependent work instead of stopping or substituting unrelated imagery.

## Engineering expectations

Use the stack and constraints in `CLAUDE.md`.

The application must eventually run locally using Docker Compose with the real web app, worker, Postgres and Redis.

Do not build AWS infrastructure yet.

Do not skip:
- RBAC
- provider tenant isolation
- audit logging
- state machines
- database constraints
- timezone handling
- background jobs
- AI call reliability logging (no token accounting or cost estimation — see ADR-015)
- failure handling
- unit/integration/contract/database tests
- AI evals
- loading/empty/error states
- accessibility
- security

Do **not** create a screenshot-based, video-based, visual-regression, or recorded E2E suite.
No Playwright/Cypress screenshot baselines, videos, traces, or visual-diff CI artifacts.
Production readiness must come from deterministic tests, integration/contract coverage, database integrity checks, security/RBAC tests, AI evals, build/runtime smoke checks, and manual verification in the real running application.

## Critical working rule

Work strictly phase-by-phase, but **continue automatically through every phase**.

Do **not** start by spraying code across every page at once. Complete one phase properly, run its quality gates, update the build log, and then move to the next phase without waiting for my approval.

Before writing code:

1. inspect the entire existing repository;
2. inspect the supplied `apron-production-assets` pack and visual reference;
3. summarize what currently exists;
4. identify anything reusable vs anything that conflicts with `CLAUDE.md`;
5. propose the exact Phase 0 implementation plan and a concise roadmap for later phases;
6. create/update:
   - `docs/BUILD_STATUS.md`
   - `docs/DECISIONS.md`

Then implement Phase 0.

After each phase:

- run the relevant quality gates;
- record files created/changed;
- record exact commands and results;
- record Docker/runtime status where relevant;
- record assumptions/questions;
- fix failures before marking the phase complete;
- continue directly into the next phase.

### Questions

If you need clarification, ask me alongside your progress, but **do not stop the build just because a question is unanswered**.

Unless the uncertainty would cause destructive data loss, a serious security/compliance problem, or an irreversible architectural mistake:
- write down the question;
- document the safest reversible assumption;
- isolate the assumption behind configuration where practical;
- continue implementing.

I may answer while you are working, but the default behavior is **keep moving**.

### Required completion behavior

Do not stop after Phase 0.
Do not stop after the first working UI.
Do not stop after auth.
Do not stop after the AI intake.
Do not silently shrink scope.

Continue through all phases in `CLAUDE.md` until the application is locally production-ready.

Do not hide failures.
Do not call a phase complete with failing tests.
Do not create fake services simply to make the UI appear complete.
Do not leave core functionality as TODOs.

The goal is to build **Apron Production** as a serious full-stack + AI engineering product with a calm, cool, premium modern design and production-grade operational correctness.
