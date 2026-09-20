import { describe, expect, it } from 'vitest';
import { isAllowedUpn } from './allowlist';

describe('isAllowedUpn', () => {
  it('matches when the candidate equals the allowed UPN exactly', () => {
    expect(isAllowedUpn('dom@valliance.ai', 'dom@valliance.ai')).toBe(true);
  });

  it('matches regardless of letter case', () => {
    expect(isAllowedUpn('Dom@Valliance.AI', 'dom@valliance.ai')).toBe(true);
  });

  it('matches when the candidate carries leading or trailing whitespace', () => {
    expect(isAllowedUpn('  dom@valliance.ai  ', 'dom@valliance.ai')).toBe(true);
  });

  it('rejects a different user', () => {
    expect(isAllowedUpn('someone.else@valliance.ai', 'dom@valliance.ai')).toBe(false);
  });

  it('rejects a null candidate', () => {
    expect(isAllowedUpn(null, 'dom@valliance.ai')).toBe(false);
  });

  it('rejects an undefined candidate', () => {
    expect(isAllowedUpn(undefined, 'dom@valliance.ai')).toBe(false);
  });

  it('rejects an empty candidate', () => {
    expect(isAllowedUpn('', 'dom@valliance.ai')).toBe(false);
  });
});
