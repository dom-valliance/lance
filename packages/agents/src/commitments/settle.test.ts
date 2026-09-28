import { describe, expect, it } from 'vitest';
import { namesPrincipal, settleOwedToPrincipal, type SettleableCandidate } from './settle.js';

const principal = { name: 'Dom Selvon', email: 'dom@valliance.ai' };

const inbound = (overrides: Partial<SettleableCandidate>): SettleableCandidate => ({
  direction: 'inbound',
  promisedTo: 'Dom Selvon',
  owedToPrincipal: 'definite',
  ...overrides,
});

describe('namesPrincipal', () => {
  it('knows the full name, the first name and the email, ignoring case', () => {
    expect(namesPrincipal('Dom Selvon', principal)).toBe(true);
    expect(namesPrincipal('dom', principal)).toBe(true);
    expect(namesPrincipal('DOM@valliance.ai', principal)).toBe(true);
  });

  it('refuses another person, a group and nobody', () => {
    expect(namesPrincipal('Priya Nandra', principal)).toBe(false);
    expect(namesPrincipal('Dom and Priya', principal)).toBe(false);
    expect(namesPrincipal('the Valliance team', principal)).toBe(false);
    expect(namesPrincipal(null, principal)).toBe(false);
  });
});

describe('settleOwedToPrincipal', () => {
  it('keeps a definite promise made to the principal', () => {
    expect(settleOwedToPrincipal([inbound({})], principal)[0]?.owedToPrincipal).toBe('definite');
  });

  it('lowers a definite promise made to someone else to possible', () => {
    const [settled] = settleOwedToPrincipal([inbound({ promisedTo: 'Priya Nandra' })], principal);
    expect(settled?.owedToPrincipal).toBe('possible');
  });

  it('lowers a definite promise with no recipient to possible', () => {
    const [settled] = settleOwedToPrincipal([inbound({ promisedTo: null })], principal);
    expect(settled?.owedToPrincipal).toBe('possible');
  });

  it('reads a missing certainty on an inbound promise as possible', () => {
    const [settled] = settleOwedToPrincipal([inbound({ owedToPrincipal: null })], principal);
    expect(settled?.owedToPrincipal).toBe('possible');
  });

  it('discards a promise made to someone other than the principal', () => {
    expect(
      settleOwedToPrincipal([inbound({ owedToPrincipal: 'not_principal' })], principal),
    ).toEqual([]);
  });

  it('never raises a possible promise, even one that names the principal', () => {
    const [settled] = settleOwedToPrincipal([inbound({ owedToPrincipal: 'possible' })], principal);
    expect(settled?.owedToPrincipal).toBe('possible');
  });

  it('clears the certainty of an outbound promise', () => {
    const [settled] = settleOwedToPrincipal(
      [{ direction: 'outbound', promisedTo: 'Ann Example', owedToPrincipal: 'possible' }],
      principal,
    );
    expect(settled?.owedToPrincipal).toBeNull();
  });
});
