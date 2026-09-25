# Build context is the repository root, not apps/api: the api imports
# @lance/connectors, @lance/db, @lance/ledger, @lance/shared and
# @lance/telemetry as workspace TypeScript source.
#
#   docker build -f apps/api/Dockerfile -t lance-api .
#
# The image runs the TypeScript directly under tsx rather than shipping a
# compiled bundle. Every package in this repository exports `./src/*.ts` and
# every build script is `tsc --noEmit`, so there is no emit step to copy: a
# compiled api would need a new build pipeline for four packages to gain
# nothing but start-up time. Revisit when the packages emit JavaScript.

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
RUN pnpm install --frozen-lockfile --filter @lance/api...

# Only the source the api actually loads. Nothing else is copied, so the
# image carries no fixtures, no tests from other packages and no .env.
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
COPY packages/connectors/src packages/connectors/src
COPY packages/db/src packages/db/src
COPY packages/db/drizzle packages/db/drizzle
COPY packages/ledger/src packages/ledger/src
COPY packages/ontology/src packages/ontology/src
COPY packages/shared/src packages/shared/src
# The data-processing notice: the api hashes it at start up (onboarding/notice.ts).
COPY packages/shared/content packages/shared/content
COPY packages/telemetry/src packages/telemetry/src

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app/apps/api

COPY --from=deps --chown=node:node /app /app

# The node image ships an unprivileged `node` user; the process never needs root.
USER node
EXPOSE 3001

CMD ["./node_modules/.bin/tsx", "src/main.ts"]
