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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The data-processing notice onboarding shows (docs/plans/multi-user.md M3
 * and M7). It is read here, at build time, and inlined with its SHA-256,
 * so the running server needs no file of its own and a principal's
 * acceptance names exactly the text they were shown. A build without the
 * file fails here with a message saying where it goes, rather than
 * shipping an onboarding page with nothing to accept.
 */
const NOTICE_PATH = fileURLToPath(
  new URL('./src/content/data-processing-notice.md', import.meta.url),
);

function readNotice() {
  if (!existsSync(NOTICE_PATH)) {
    throw new Error(
      `The data-processing notice is missing: expected ${NOTICE_PATH}. ` +
        'Onboarding cannot be built without it. The compliance package writes it ' +
        '(docs/plans/multi-user.md M7); restore the file and build again.',
    );
  }
  const markdown = readFileSync(NOTICE_PATH, 'utf8');
  if (markdown.trim() === '') {
    throw new Error(
      `The data-processing notice at ${NOTICE_PATH} is empty. Write it and build again.`,
    );
  }
  return { markdown, sha256: createHash('sha256').update(markdown, 'utf8').digest('hex') };
}

const notice = readNotice();

const nextConfig = {
  // Inlined wherever server code reads process.env.DATA_PROCESSING_NOTICE
  // or process.env.DATA_PROCESSING_NOTICE_SHA256 (src/lib/notice.ts).
  env: {
    DATA_PROCESSING_NOTICE: notice.markdown,
    DATA_PROCESSING_NOTICE_SHA256: notice.sha256,
  },
  output: 'standalone',
  // The app lives in a pnpm workspace, so the standalone trace must start at
  // the repository root or hoisted dependencies are left out of the bundle.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default nextConfig;
