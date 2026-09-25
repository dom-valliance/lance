import { describe, expect, it } from 'vitest';
import {
  isUnsetSecretValue,
  LEGACY_GRAPH_PLACEHOLDER,
  PLACEHOLDER_SECRET_VALUE,
  principalSecretName,
} from './principalSecrets.js';

const PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E300H';

describe('principalSecretName', () => {
  it('names each connector secret with the principal id after a double hyphen', () => {
    expect(principalSecretName('graph-refresh-token', PRINCIPAL)).toBe(
      `graph-refresh-token--${PRINCIPAL}`,
    );
    expect(principalSecretName('jamie-api-key', PRINCIPAL)).toBe(`jamie-api-key--${PRINCIPAL}`);
    expect(principalSecretName('foundry-refresh-token', PRINCIPAL)).toBe(
      `foundry-refresh-token--${PRINCIPAL}`,
    );
  });

  it('produces a name Key Vault accepts: letters, digits and hyphens, at most 127 characters', () => {
    const name = principalSecretName('foundry-refresh-token', PRINCIPAL);
    expect(name).toMatch(/^[0-9a-zA-Z-]{1,127}$/);
  });

  it('refuses a principal id that is not a ULID', () => {
    expect(() => principalSecretName('jamie-api-key', 'dom')).toThrow(/ULID/);
    expect(() => principalSecretName('jamie-api-key', `${PRINCIPAL}--x`)).toThrow(/ULID/);
  });
});

describe('isUnsetSecretValue', () => {
  it('reads absence and both placeholders as unset', () => {
    expect(isUnsetSecretValue(undefined)).toBe(true);
    expect(isUnsetSecretValue(null)).toBe(true);
    expect(isUnsetSecretValue('')).toBe(true);
    expect(isUnsetSecretValue(PLACEHOLDER_SECRET_VALUE)).toBe(true);
    expect(isUnsetSecretValue(LEGACY_GRAPH_PLACEHOLDER)).toBe(true);
  });

  it('reads anything else as set', () => {
    expect(isUnsetSecretValue('jk_live')).toBe(false);
  });
});
