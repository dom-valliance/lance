import { describe, expect, it } from 'vitest';
import {
  decide,
  jaroWinkler,
  nameOrganisationScore,
  normaliseName,
  organisationDomain,
} from './resolution.js';

describe('normaliseName', () => {
  it('lower-cases, strips diacritics and honorifics and collapses spaces', () => {
    expect(normaliseName('  Dr.  Zoë   O’Brien ')).toBe("zoe o'brien");
    expect(normaliseName('Mr Alec Boere')).toBe('alec boere');
    expect(normaliseName('Prof. Anita Rajdev')).toBe('anita rajdev');
  });
});

describe('organisationDomain', () => {
  it('returns the domain of a work address and null for a public provider', () => {
    expect(organisationDomain('ann@client.test')).toBe('client.test');
    expect(organisationDomain('ann@gmail.com')).toBeNull();
    expect(organisationDomain('not-an-address')).toBeNull();
  });
});

describe('jaroWinkler', () => {
  it('scores identical strings one, unrelated strings low and near misses high', () => {
    expect(jaroWinkler('alec boere', 'alec boere')).toBe(1);
    expect(jaroWinkler('alec boere', 'alex boere')).toBeGreaterThan(0.9);
    expect(jaroWinkler('alec boere', 'volha dashkevich')).toBeLessThan(0.6);
  });
});

describe('nameOrganisationScore and decide', () => {
  it('merges the same name at the same organisation', () => {
    const score = nameOrganisationScore(
      { name: 'Alec Boere', organisation: 'client.test' },
      { name: 'alec boere', organisation: 'client.test' },
    );
    expect(decide(score)).toBe('merge');
  });

  it('makes a candidate of the same name with one organisation unknown', () => {
    const score = nameOrganisationScore(
      { name: 'Alec Boere', organisation: null },
      { name: 'Alec Boere', organisation: 'client.test' },
    );
    expect(score).toBeCloseTo(0.9, 5);
    expect(decide(score)).toBe('candidate');
  });

  it('rules out the same name at different organisations', () => {
    const score = nameOrganisationScore(
      { name: 'Alec Boere', organisation: 'one.test' },
      { name: 'Alec Boere', organisation: 'two.test' },
    );
    expect(decide(score)).toBe('none');
  });
});
