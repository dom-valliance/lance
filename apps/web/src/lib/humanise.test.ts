import { describe, expect, it } from 'vitest';
import { ACTION_CLASS_LABELS, humanise, shortId, SYSTEM_LABELS } from './humanise';

describe('humanise', () => {
  it('turns an unknown snake_case value into a sentence-case label', () => {
    expect(humanise('stale_watermark')).toBe('Stale watermark');
  });

  it('leaves an empty value alone', () => {
    expect(humanise('')).toBe('');
  });

  it('names Microsoft 365 rather than graph', () => {
    expect(SYSTEM_LABELS.graph).toBe('Microsoft 365');
  });

  it('spells the action class out in plain words', () => {
    expect(ACTION_CLASS_LABELS.create_calendar_hold).toBe('Create calendar hold');
  });
});

describe('shortId', () => {
  it('keeps a short id whole', () => {
    expect(shortId('tr_71c0e')).toBe('tr_71c0e');
  });

  it('keeps the first eight and the last three characters of a long id', () => {
    expect(shortId('01K5S9V6QW3SWCCPVB0N0E301A')).toBe('01K5S9V6…01A');
  });
});
