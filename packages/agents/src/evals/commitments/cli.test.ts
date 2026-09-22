import { describe, expect, it, vi } from 'vitest';

import { loadModelExtractor, main, scriptedExtractor } from './cli.js';
import { COMMITMENTS_FIXTURES_DIR, loadCommitmentFixtures } from './fixtures.js';

const [firstFixture] = loadCommitmentFixtures(COMMITMENTS_FIXTURES_DIR);

function silenceOutput(): void {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('scriptedExtractor', () => {
  it('replays the expected commitments with the record id attached', async () => {
    expect(firstFixture).toBeDefined();
    if (firstFixture === undefined) return;
    const extracted = await scriptedExtractor(firstFixture);
    expect(extracted).toHaveLength(firstFixture.expected.length);
    expect(extracted.every((item) => item.recordId === firstFixture.id)).toBe(true);
  });
});

describe('loadModelExtractor', () => {
  it('explains which deps the CLI cannot supply when the factory needs them', async () => {
    await expect(loadModelExtractor()).rejects.toThrow(/EVAL_EXTRACTOR=scripted/);
  });
});

describe('main', () => {
  it('returns 0 when the scripted extractor clears the regression floor', async () => {
    silenceOutput();
    await expect(main({ EVAL_EXTRACTOR: 'scripted', EVAL_MIN_F1: '1' })).resolves.toBe(0);
  });

  it('runs only the filtered records', async () => {
    silenceOutput();
    const info = vi.spyOn(console, 'info');
    await main({ EVAL_EXTRACTOR: 'scripted', EVAL_FILTER: 't01' });
    expect(info.mock.calls[0]?.[0]).toContain('Records 1');
  });

  it('returns 1 when F1 falls below the regression floor', async () => {
    silenceOutput();
    await expect(main({ EVAL_EXTRACTOR: 'scripted', EVAL_MIN_F1: '1.1' })).resolves.toBe(1);
  });

  it('ignores a regression floor that is not a number', async () => {
    silenceOutput();
    await expect(main({ EVAL_EXTRACTOR: 'scripted', EVAL_MIN_F1: 'high' })).resolves.toBe(0);
  });
});
