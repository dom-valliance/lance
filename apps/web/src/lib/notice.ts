import { createHash } from 'node:crypto';

/**
 * The data-processing notice (docs/plans/multi-user.md M3, step 1), inlined
 * at build time by `next.config.ts` from
 * `apps/web/src/content/data-processing-notice.md` with its SHA-256. The
 * hash is what an acceptance records, so a changed notice is a new hash
 * and every principal is asked again.
 */

export interface Notice {
  markdown: string;
  /** Lowercase hex SHA-256 of the file's UTF-8 bytes. */
  sha256: string;
}

/** The SHA-256 the build computes, for a test to compare against. */
export function noticeHash(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

/**
 * The notice this build carries. Next replaces the dot-access form of
 * these two names at build time, so they are read exactly this way.
 */
export function dataProcessingNotice(
  markdown: string | undefined = process.env.DATA_PROCESSING_NOTICE,
  sha256: string | undefined = process.env.DATA_PROCESSING_NOTICE_SHA256,
): Notice {
  if (markdown === undefined || markdown === '' || sha256 === undefined || sha256 === '') {
    throw new Error(
      'This build carries no data-processing notice. next.config.ts inlines apps/web/src/content/data-processing-notice.md at build time; build the web app with that file in place.',
    );
  }
  return { markdown, sha256 };
}
