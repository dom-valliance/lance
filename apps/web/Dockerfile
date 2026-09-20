# Multi-stage build for @lance/web. Build context is the repository root
# (docker build -f apps/web/Dockerfile .): pnpm workspaces need the root
# lockfile and workspace manifest, and @lance/web has no cross-package
# dependencies on packages/* to prune around.

FROM node:22-alpine AS base
RUN corepack enable

# ---- deps: install the full workspace, matched to the committed lockfile ----
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# ---- builder: produce the standalone Next.js server bundle ----
FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN pnpm --filter @lance/web build

# ---- runner: minimal, non-root runtime image ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 web

# `output: 'standalone'` (next.config.ts) traces only the dependencies the
# running server needs, so the runtime image never gets a copy of the full
# workspace node_modules.
COPY --from=builder --chown=web:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=web:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=web:nodejs /repo/apps/web/public ./apps/web/public

USER web
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
