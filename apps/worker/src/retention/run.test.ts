import { loadConfig } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { nightlyWindows, offboardingWindows, retentionWindowsFor } from './run.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
});

describe('retentionWindowsFor', () => {
  it('keeps the zero-day offboarding windows for an offboarded principal every night', () => {
    const windows = retentionWindowsFor(config, 'nightly', 'offboarded');

    expect(windows).toEqual(offboardingWindows(config));
    expect([windows.mailBodiesDays, windows.transcriptsDays, windows.modelLogsDays]).toEqual([
      0, 0, 0,
    ]);
  });

  it('uses the normal windows for an active or paused principal', () => {
    expect(retentionWindowsFor(config, 'nightly', 'active')).toEqual(nightlyWindows(config));
    expect(retentionWindowsFor(config, 'nightly', 'paused')).toEqual(nightlyWindows(config));
  });

  it('uses the offboarding windows for the offboarding run itself', () => {
    expect(retentionWindowsFor(config, 'offboarding', 'active')).toEqual(
      offboardingWindows(config),
    );
  });
});
