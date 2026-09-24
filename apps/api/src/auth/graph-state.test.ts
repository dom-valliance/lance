import { describe, expect, it } from 'vitest';
import { CONSENT_STATE_TTL_MS, createConsentStateStore } from './graph-state.js';

const PRINCIPAL = { id: '01K5S9V6QW3SWCCPVB0N0E300H', upn: 'dom@valliance.ai' };

describe('the consent state store', () => {
  it('returns the verifier issued for a state', () => {
    const store = createConsentStateStore();
    store.issue('a-state', 'a-code-verifier', PRINCIPAL);

    expect(store.claim('a-state')).toEqual({
      codeVerifier: 'a-code-verifier',
      principal: PRINCIPAL,
    });
  });

  it('returns null for a state it never issued', () => {
    expect(createConsentStateStore().claim('an-unknown-state')).toBeNull();
  });

  it('accepts a state once, so a replayed callback finds nothing', () => {
    const store = createConsentStateStore();
    store.issue('a-state', 'a-code-verifier', PRINCIPAL);

    expect(store.claim('a-state')).toEqual({
      codeVerifier: 'a-code-verifier',
      principal: PRINCIPAL,
    });
    expect(store.claim('a-state')).toBeNull();
  });

  it('forgets an attempt older than ten minutes', () => {
    let clock = 1_000_000;
    const store = createConsentStateStore({ now: () => clock });
    store.issue('a-state', 'a-code-verifier', PRINCIPAL);

    clock += CONSENT_STATE_TTL_MS + 1;

    expect(store.claim('a-state')).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('keeps an attempt that is still inside the window', () => {
    let clock = 1_000_000;
    const store = createConsentStateStore({ now: () => clock });
    store.issue('a-state', 'a-code-verifier', PRINCIPAL);

    clock += CONSENT_STATE_TTL_MS - 1_000;

    expect(store.claim('a-state')).toEqual({
      codeVerifier: 'a-code-verifier',
      principal: PRINCIPAL,
    });
  });

  it('prunes expired attempts when a new one is issued', () => {
    let clock = 1_000_000;
    const store = createConsentStateStore({ now: () => clock });
    store.issue('first', 'verifier-one', PRINCIPAL);

    clock += CONSENT_STATE_TTL_MS + 1;
    store.issue('second', 'verifier-two', PRINCIPAL);

    expect(store.size()).toBe(1);
    expect(store.claim('first')).toBeNull();
    expect(store.claim('second')?.codeVerifier).toBe('verifier-two');
  });
});
