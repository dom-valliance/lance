# @lance/web

The Lance web shell: Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui,
Auth.js v5 against Microsoft Entra ID. Server components by default.

## Development

```bash
cp .env.example .env.local # then fill in the Entra and Auth.js values
pnpm --filter @lance/web dev
```

Sign-in is restricted to the single UPN in `ALLOWED_UPN`. See
`docs/runbooks/entra-setup.md` at the repo root for registering the Entra
app, and `public/fonts/README.md` for the Satoshi font files this app
expects but does not ship.

## Scripts

| Script      | What it does                      |
| ----------- | --------------------------------- |
| `dev`       | `next dev -p 3000`                |
| `build`     | `next build`                      |
| `start`     | `next start -p 3000`              |
| `lint`      | `eslint .`                        |
| `typecheck` | `tsc --noEmit -p tsconfig.json`   |
| `test`      | `vitest run`                      |
| `e2e`       | `playwright test` (chromium only) |

## Structure

- `src/app`: routes. Each of the ten sidebar pages is a server component.
- `src/auth.ts`, `src/auth/allowlist.ts`: Auth.js configuration and the
  allowlist decision function.
- `src/proxy.ts`: the Next.js 16 proxy (formerly `middleware.ts`) that
  guards every route except `/api/auth/*`, `/fonts/*` and `/_next/*`.
- `src/lib/api.ts`, `src/lib/sse.ts`: the API base URL helper and an SSE
  hook, both unused until `apps/api` exposes an `AppRouter` and an events
  endpoint (WP0.8).
- `src/components/ui`: shadcn components (`button`, `card`, `badge`,
  `separator`).
