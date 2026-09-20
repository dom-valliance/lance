import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRecord, idempotencyKey, sha256Hex } from './hash.js';

describe('canonicalJson', () => {
  it('produces the same output regardless of key order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 1 })).toBe('{"a":1,"b":{"c":2,"d":1}}');
  });

  it('serialises dates as ISO strings', () => {
    const iso = '2026-03-29T00:00:00.000Z';
    expect(canonicalJson({ at: new Date(iso) })).toBe(`{"at":"${iso}"}`);
  });

  it('drops undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('produces no whitespace', () => {
    expect(canonicalJson({ a: 1, b: 2 })).not.toMatch(/\s/);
  });
});

describe('sha256Hex', () => {
  it('returns the known SHA-256 digest for an empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('hashRecord', () => {
  it('is stable across differently ordered but equal objects', () => {
    const first = hashRecord({ a: 1, b: { x: 1, y: 2 } });
    const second = hashRecord({ b: { y: 2, x: 1 }, a: 1 });
    expect(first).toBe(second);
  });

  it('differs for genuinely different content', () => {
    expect(hashRecord({ a: 1 })).not.toBe(hashRecord({ a: 2 }));
  });
});

describe('idempotencyKey', () => {
  it('formats as system:recordId:contentHash', () => {
    expect(idempotencyKey('graph', 'message-123', 'abcdef')).toBe('graph:message-123:abcdef');
  });
});
