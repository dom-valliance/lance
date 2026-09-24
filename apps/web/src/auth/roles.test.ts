import { describe, expect, it } from 'vitest';
import { admitsSignIn, identityFromIdToken, lanceRolesFrom } from './roles';

function jwtWith(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

describe('admitsSignIn', () => {
  it('refuses a profile whose token carries neither Lance role', () => {
    expect(admitsSignIn({ roles: ['Other.Role'] })).toBe(false);
    expect(admitsSignIn({})).toBe(false);
    expect(admitsSignIn(undefined)).toBe(false);
  });

  it('admits a Lance.User', () => {
    expect(admitsSignIn({ roles: ['Lance.User'] })).toBe(true);
  });

  it('admits a Lance.Admin without Lance.User', () => {
    expect(admitsSignIn({ roles: ['Lance.Admin'] })).toBe(true);
  });
});

describe('lanceRolesFrom', () => {
  it('keeps each Lance role once and drops the rest', () => {
    expect(lanceRolesFrom(['Lance.Admin', 'Lance.Admin', 7, 'Else'])).toEqual(['Lance.Admin']);
  });
});

describe('identityFromIdToken', () => {
  it('reads the object id and the Lance roles from the id token', () => {
    const token = jwtWith({ oid: 'object-1', roles: ['Lance.User', 'Other.Role'] });
    expect(identityFromIdToken(token)).toEqual({ oid: 'object-1', roles: ['Lance.User'] });
  });

  it('reads an unreadable token as no identity', () => {
    expect(identityFromIdToken('not-a-jwt')).toEqual({ oid: null, roles: [] });
  });
});
