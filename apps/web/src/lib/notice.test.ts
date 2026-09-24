import { describe, expect, it } from 'vitest';
import { dataProcessingNotice, noticeHash } from './notice';

/** Fixture text of our own: package 5.6 writes the real notice. */
const FIXTURE = '# How Lance uses your data\n\nLance reads your mail and calendar.\n';

describe('dataProcessingNotice', () => {
  it('returns the notice the build inlined with its SHA-256', () => {
    const sha256 = noticeHash(FIXTURE);
    expect(dataProcessingNotice(FIXTURE, sha256)).toEqual({ markdown: FIXTURE, sha256 });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives a changed notice a different hash, so every principal is asked again', () => {
    expect(noticeHash(`${FIXTURE}\nIt keeps mail bodies for 90 days.\n`)).not.toBe(
      noticeHash(FIXTURE),
    );
  });

  it('fails loudly, naming the file, when the build carried no notice', () => {
    expect(() => dataProcessingNotice(undefined, undefined)).toThrow(
      'apps/web/src/content/data-processing-notice.md',
    );
    expect(() => dataProcessingNotice('', 'abc')).toThrow('carries no data-processing notice');
  });
});
