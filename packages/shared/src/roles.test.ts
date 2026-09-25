import { describe, expect, it } from 'vitest';
import { hasLanceAccess, isLanceAdmin, lanceRolesFrom } from './roles.js';

describe('lanceRolesFrom', () => {
  it('keeps the Lance roles and drops every other value in the claim', () => {
    expect(lanceRolesFrom(['Other.Role', 'Lance.User', 42, 'Lance.User'])).toEqual(['Lance.User']);
  });

  it('reads a missing or malformed claim as no roles', () => {
    expect(lanceRolesFrom(undefined)).toEqual([]);
    expect(lanceRolesFrom('Lance.Admin')).toEqual([]);
  });
});

describe('access', () => {
  it('admits either role and refuses none', () => {
    expect(hasLanceAccess(['Lance.User'])).toBe(true);
    expect(hasLanceAccess(['Lance.Admin'])).toBe(true);
    expect(hasLanceAccess([])).toBe(false);
  });

  it('treats only Lance.Admin as an admin', () => {
    expect(isLanceAdmin(['Lance.User'])).toBe(false);
    expect(isLanceAdmin(['Lance.User', 'Lance.Admin'])).toBe(true);
  });
});
