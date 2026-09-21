# Build context is the repository root (docker build -f apps/web/Dockerfile .):
# pnpm workspaces need the root lockfile and workspace manifest even though
# @lance/web depends on no packages/* package.

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo

# Manifests first, so a source-only change reuses the install layer. Every
# workspace manifest is listed because the lockfile covers the whole workspace.
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
RUN pnpm install --frozen-lockfile --filter @lance/web...

# Build the standalone Next.js server. Only the web app's own files are
# copied; next.config.ts roots the file trace at /repo.
FROM deps AS builder
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @lance/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `output: 'standalone'` traces only what the server needs, so the runtime
# image never carries the workspace node_modules.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
