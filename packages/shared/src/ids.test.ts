import { describe, expect, it } from 'vitest';
import { isUlid, newUlid } from './ids.js';

describe('newUlid', () => {
  it('generates a 26-character Crockford base32 string', () => {
    const id = newUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('generates a distinct value on each call', () => {
    expect(newUlid()).not.toBe(newUlid());
  });
});

describe('isUlid', () => {
  it('accepts a freshly generated ulid', () => {
    expect(isUlid(newUlid())).toBe(true);
  });

  it('rejects a string of the wrong length', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false);
  });

  it('rejects a string with disallowed Crockford characters', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FIL')).toBe(false);
  });

  it('rejects a lower-case ulid', () => {
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false);
  });
});

describe('stableUlid', () => {
  it('returns the same valid ULID for the same seed and different ones for different seeds', async () => {
    const { stableUlid, isUlid } = await import('./ids.js');
    const a = stableUlid('graph:conversation-1');
    expect(isUlid(a)).toBe(true);
    expect(stableUlid('graph:conversation-1')).toBe(a);
    expect(stableUlid('graph:conversation-2')).not.toBe(a);
    expect('01234567').toContain(a[0]);
  });
});
