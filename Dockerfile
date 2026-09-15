# syntax=docker/dockerfile:1.7
#
# Apron Production — one image, two entrypoints (ADR-001).
#
# `web`    runs the Next.js standalone server.
# `worker` runs the bundled BullMQ worker.
#
# Debian slim rather than Alpine: the argon2 and pg native paths have first-class glibc
# prebuilds, and musl variants are the most common source of "works locally, not in the
# image" failures on this stack.

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------------------------------------------------------------------------
# The runtime tree, without devDependencies.
#
# The worker image needs real node_modules for the packages left external to its bundle,
# but it must not inherit the build's. `npm ci` installs esbuild, whose platform package is
# a Go binary — shipping it put a Go standard-library CVE into an image that never runs it,
# alongside tsx and vitest. A smaller image is the lesser reason; not carrying code that
# cannot execute is the real one.
#
# pino-pretty is a devDependency and is deliberately absent here. The logger catches that
# and falls back to JSON, which is what a deployed environment wants regardless.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must not depend on real secrets. These placeholders satisfy env validation
# during the static build only; the running container receives the real values.
ENV NODE_ENV=production \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    REDIS_URL=redis://localhost:6379 \
    SESSION_SECRET=build-time-placeholder-not-used-at-runtime-000 \
    AI_ENABLED=false

RUN npm run build && npm run build:worker

# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner-base
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# `upgrade` as well as `install`: the base tag is rebuilt on its own schedule, so between
# rebuilds it carries OS packages that already have published fixes. Without this the image
# scan fails on vulnerabilities patched upstream and simply not pulled in yet.
#
# npm goes too. Nothing at runtime invokes it — every entrypoint and every Compose command
# is `node ...` — and the npm the base image bundles vendors its own tar, sigstore and
# picomatch, which is where the remaining scan findings were coming from. They cannot be
# patched by upgrading anything of ours, and removing a package manager from a running
# container is worth doing on its own merits.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends curl dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && groupadd --system --gid 1001 apron \
 && useradd --system --uid 1001 --gid apron apron

# ---------------------------------------------------------------------------
FROM runner-base AS web
COPY --from=builder --chown=apron:apron /app/public ./public
COPY --from=builder --chown=apron:apron /app/.next/standalone ./
COPY --from=builder --chown=apron:apron /app/.next/static ./.next/static
USER apron
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
FROM runner-base AS worker
# The worker needs the migration SQL and the seed data, and the production-only dependency
# tree for the packages left external to the bundle.
COPY --from=prod-deps --chown=apron:apron /app/node_modules ./node_modules
COPY --from=builder --chown=apron:apron /app/dist-worker ./dist-worker
COPY --from=builder --chown=apron:apron /app/src/db/migrations ./src/db/migrations
COPY --from=builder --chown=apron:apron /app/package.json ./package.json
USER apron
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist-worker/worker.js"]
