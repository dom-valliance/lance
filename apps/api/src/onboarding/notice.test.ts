import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { currentNoticeSha256, NOTICE_PATH } from './notice.js';

describe('currentNoticeSha256', () => {
  it('is the SHA-256 of the notice file the web app shows', () => {
    const markdown = readFileSync(NOTICE_PATH, 'utf8');

    expect(currentNoticeSha256()).toBe(createHash('sha256').update(markdown, 'utf8').digest('hex'));
    expect(markdown).toContain('Lance');
  });

  it('fails naming the file when it is missing', () => {
    expect(() => currentNoticeSha256('/nowhere/data-processing-notice.md')).toThrow(
      '/nowhere/data-processing-notice.md',
    );
  });
});
