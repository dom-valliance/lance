import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { isLegacyOwner, principalDisplayName, principalIdentity } from './principal.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/lance' });

describe('principalIdentity', () => {
  it("names the legacy owner with the configured name and the owner's UPN", () => {
    expect(principalIdentity({ upn: 'Dom@Valliance.ai', notionUserId: 'n-dom' }, config)).toEqual({
      name: 'Dom Selvon',
      email: 'dom@valliance.ai',
      notionUserId: 'n-dom',
    });
  });

  it("never gives another principal Dom's name or email", () => {
    const bea = principalIdentity({ upn: 'bea.hale@valliance.ai', notionUserId: null }, config);
    expect(bea).toEqual({ name: 'Bea Hale', email: 'bea.hale@valliance.ai', notionUserId: null });
  });

  it("prefers the Notion user id the principal's credential resolved", () => {
    expect(
      principalIdentity({ upn: 'bea@valliance.ai', notionUserId: 'n-row' }, config, 'n-cred')
        .notionUserId,
    ).toBe('n-cred');
  });
});

describe('principalDisplayName', () => {
  it('falls back to the UPN when the local part has no letters to name', () => {
    expect(principalDisplayName('._@valliance.ai', config)).toBe('._@valliance.ai');
  });
});

describe('isLegacyOwner', () => {
  it('matches the configured UPN whatever the case', () => {
    expect(isLegacyOwner('DOM@valliance.ai', config)).toBe(true);
    expect(isLegacyOwner('bea@valliance.ai', config)).toBe(false);
  });
});
