import { PLACEHOLDER_SECRET_VALUE } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import {
  InMemorySecrets,
  KeyVaultSecrets,
  principalVaultFromEnv,
  staticVaultFromEnv,
  writeOnly,
  type SecretClientLike,
} from './vault.js';

const clientHolding = (value: string | undefined | Error): SecretClientLike => ({
  getSecret: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve({ value })),
  setSecret: () => Promise.resolve({}),
});

describe('KeyVaultSecrets', () => {
  it('reads the placeholder the template writes as not set', async () => {
    await expect(
      new KeyVaultSecrets(clientHolding(PLACEHOLDER_SECRET_VALUE)).get('jamie-api-key'),
    ).resolves.toBeNull();
  });

  it('reads a missing secret as not set', async () => {
    const missing = Object.assign(new Error('not found'), { code: 'SecretNotFound' });
    await expect(new KeyVaultSecrets(clientHolding(missing)).get('x')).resolves.toBeNull();
  });

  it('returns a real value', async () => {
    await expect(new KeyVaultSecrets(clientHolding('jk_real')).get('x')).resolves.toBe('jk_real');
  });
});

describe('writeOnly', () => {
  it('passes writes through and exposes nothing that reads', async () => {
    const store = new InMemorySecrets();
    const writer = writeOnly(store);
    await writer.set('jamie-api-key--01K5S9V6QW3SWCCPVB0N0E300H', 'jk_new');

    expect(store.writes).toEqual([
      { name: 'jamie-api-key--01K5S9V6QW3SWCCPVB0N0E300H', value: 'jk_new' },
    ]);
    expect(Object.keys(writer)).toEqual(['set']);
  });
});

describe('vaults from the environment', () => {
  it('is null for a process without the vault URLs, such as a local run', () => {
    expect(principalVaultFromEnv({})).toBeNull();
    expect(staticVaultFromEnv({ KEY_VAULT_URL: '' })).toBeNull();
  });

  it('builds a client when the URL is set', () => {
    expect(
      principalVaultFromEnv({
        PRINCIPAL_KEY_VAULT_URL: 'https://kv-lance-p-dev-abcd.vault.azure.net',
      }),
    ).toBeInstanceOf(KeyVaultSecrets);
  });
});

describe('KeyVaultSecrets.delete', () => {
  const deleting = (outcome: 'ok' | Error): SecretClientLike & { deleted: string[] } => {
    const deleted: string[] = [];
    return {
      deleted,
      getSecret: () => Promise.resolve({}),
      setSecret: () => Promise.resolve({}),
      beginDeleteSecret: (name: string) => {
        if (outcome instanceof Error) return Promise.reject(outcome);
        deleted.push(name);
        return Promise.resolve({ pollUntilDone: () => Promise.resolve({}) });
      },
    };
  };

  it('soft-deletes the secret and waits for the delete to finish', async () => {
    const client = deleting('ok');
    await expect(new KeyVaultSecrets(client).delete('jamie-api-key--x')).resolves.toBe('deleted');
    expect(client.deleted).toEqual(['jamie-api-key--x']);
  });

  it('reads a secret that is already gone as absent, so a second run succeeds', async () => {
    const missing = Object.assign(new Error('not found'), { statusCode: 404 });
    await expect(new KeyVaultSecrets(deleting(missing)).delete('x')).resolves.toBe('absent');
  });

  it('passes any other failure on', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { statusCode: 403 });
    await expect(new KeyVaultSecrets(deleting(forbidden)).delete('x')).rejects.toThrow('forbidden');
  });
});
