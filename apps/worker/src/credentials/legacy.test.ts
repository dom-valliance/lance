import { InMemorySecrets } from '@lance/connectors';
import { PLACEHOLDER_SECRET_VALUE } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { legacyGraphToken, legacyJamieKey } from './legacy.js';

/** The copy itself runs against Postgres in jobs/connectors.test.ts. */

describe('legacyJamieKey', () => {
  it('offers JAMIE_API_KEY as the source to copy', async () => {
    const legacy = legacyJamieKey({ JAMIE_API_KEY: 'jk_doms_key' });
    expect(legacy?.from).toBe('JAMIE_API_KEY');
    await expect(legacy?.read()).resolves.toBe('jk_doms_key');
  });

  it('offers nothing when the variable is unset, empty or a placeholder', () => {
    expect(legacyJamieKey({})).toBeNull();
    expect(legacyJamieKey({ JAMIE_API_KEY: '' })).toBeNull();
    expect(legacyJamieKey({ JAMIE_API_KEY: PLACEHOLDER_SECRET_VALUE })).toBeNull();
  });
});

describe('legacyGraphToken', () => {
  it('reads graph-refresh-token from the static vault', async () => {
    const legacy = legacyGraphToken(new InMemorySecrets({ 'graph-refresh-token': 'old-token' }));
    expect(legacy?.from).toBe('graph-refresh-token');
    await expect(legacy?.read()).resolves.toBe('old-token');
  });

  it('offers nothing in a process without the static vault', () => {
    expect(legacyGraphToken(null)).toBeNull();
  });
});
