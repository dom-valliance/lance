# Build context is the repository root, not apps/worker: the worker imports
# @lance/db, @lance/ledger, @lance/shared and @lance/telemetry as workspace
# TypeScript source.
#
#   docker build -f apps/worker/Dockerfile -t lance-worker .
#
# Runs the TypeScript under tsx, for the same reason as apps/api/Dockerfile.
# The same image serves the migration job with a different command
# (infra/modules/migrate-job.bicep), so the db package's drizzle folder and
# migrate script are included.

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

# Manifests first, so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/agents/package.json packages/agents/
COPY packages/connectors/package.json packages/connectors/
COPY packages/db/package.json packages/db/
COPY packages/ledger/package.json packages/ledger/
COPY packages/ontology/package.json packages/ontology/
COPY packages/policy/package.json packages/policy/
COPY packages/shared/package.json packages/shared/
COPY packages/telemetry/package.json packages/telemetry/
RUN pnpm install --frozen-lockfile --filter @lance/worker...

# Only the source the worker actually loads. Nothing else is copied, so the
# image carries no fixtures, no tests from other packages and no .env.
COPY tsconfig.base.json ./
COPY apps/worker/tsconfig.json apps/worker/
COPY apps/worker/src apps/worker/src
COPY packages/db/src packages/db/src
COPY packages/db/drizzle packages/db/drizzle
COPY packages/ledger/src packages/ledger/src
COPY packages/shared/src packages/shared/src
COPY packages/telemetry/src packages/telemetry/src

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/worker

COPY --from=deps --chown=node:node /app /app

# The node image ships an unprivileged `node` user; the process never needs root.
USER node

CMD ["./node_modules/.bin/tsx", "src/main.ts"]
