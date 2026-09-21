/**
 * Standalone output produces a self-contained server bundle for the
 * multi-stage Dockerfile: it copies only the files the running server needs,
 * not the full node_modules tree.
 *
 * This file sits outside tsconfig.json's "include" (Next.js loads it
 * directly, not through our own tsc run) and outside the root ESLint
 * config's TypeScript-aware globs, so it deliberately avoids TS-only
 * syntax such as `import type`; the JSDoc comment still gives editors the
 * shape of `NextConfig`.
 *
 * @type {import('next').NextConfig}
 */
import { fileURLToPath } from 'node:url';

const nextConfig = {
  output: 'standalone',
  // The app lives in a pnpm workspace, so the standalone trace must start at
  // the repository root or hoisted dependencies are left out of the bundle.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default nextConfig;
