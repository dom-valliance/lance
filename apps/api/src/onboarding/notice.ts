import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The data-processing notice every principal accepts at onboarding
 * (docs/plans/multi-user.md M3). The api hashes the file itself, at start
 * up, and refuses an acceptance naming any other hash: what the ledger
 * records as accepted is the notice this build carries, never a value the
 * client chose. The web app inlines the same file at build time, and the
 * api Dockerfile copies it.
 */
export const NOTICE_PATH = fileURLToPath(
  new URL('../../../../packages/shared/content/data-processing-notice.md', import.meta.url),
);

/** Lowercase hex SHA-256 of the notice's UTF-8 bytes, as the web app computes it. */
export function noticeSha256Of(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

/** The current notice's hash. Throws, naming the file, when it is missing or empty. */
export function currentNoticeSha256(path: string = NOTICE_PATH): string {
  let markdown: string;
  try {
    markdown = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `The data-processing notice is missing: expected ${path}. The api cannot record an acceptance without it; restore the file (and the COPY in apps/api/Dockerfile) and start again.`,
    );
  }
  if (markdown.trim() === '') {
    throw new Error(
      `The data-processing notice at ${path} is empty. Restore its text and start again.`,
    );
  }
  return noticeSha256Of(markdown);
}
