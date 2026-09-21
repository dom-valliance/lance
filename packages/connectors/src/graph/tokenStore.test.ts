import { describe, expect, it } from 'vitest';
import {
  GRAPH_REFRESH_TOKEN_SECRET_NAME,
  InMemoryTokenStore,
  KeyVaultTokenStore,
  PENDING_FIRST_CONSENT,
  type SecretClientLike,
} from './tokenStore.js';

class FakeSecretClient implements SecretClientLike {
  readonly reads: string[] = [];
  readonly writes: { name: string; value: string }[] = [];

  constructor(private stored: string | undefined | Error = undefined) {}

  getSecret(name: string): Promise<{ value?: string | undefined }> {
    this.reads.push(name);
    if (this.stored instanceof Error) return Promise.reject(this.stored);
    return Promise.resolve({ value: this.stored });
  }

  setSecret(name: string, value: string): Promise<unknown> {
    this.writes.push({ name, value });
    this.stored = value;
    return Promise.resolve({ name, value });
  }
}

const notFound = (): Error => Object.assign(new Error('Secret not found'), { statusCode: 404 });

describe('KeyVaultTokenStore', () => {
  it('reads the token from the graph-refresh-token secret', async () => {
    const client = new FakeSecretClient('a-stored-refresh-token');
    const store = new KeyVaultTokenStore(client);

    await expect(store.getRefreshToken()).resolves.toBe('a-stored-refresh-token');
    expect(client.reads).toEqual([GRAPH_REFRESH_TOKEN_SECRET_NAME]);
  });

  it('returns null when the secret still holds the pending-first-consent placeholder', async () => {
    const store = new KeyVaultTokenStore(new FakeSecretClient(PENDING_FIRST_CONSENT));

    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('returns null when the secret does not exist yet', async () => {
    const store = new KeyVaultTokenStore(new FakeSecretClient(notFound()));

    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('propagates a failure that is not a missing secret', async () => {
    const store = new KeyVaultTokenStore(
      new FakeSecretClient(Object.assign(new Error('Forbidden'), { statusCode: 403 })),
    );

    await expect(store.getRefreshToken()).rejects.toThrow('Forbidden');
  });

  it('writes the rotated token back under the same secret name', async () => {
    const client = new FakeSecretClient(PENDING_FIRST_CONSENT);
    const store = new KeyVaultTokenStore(client);

    await store.setRefreshToken('the-next-refresh-token');

    expect(client.writes).toEqual([
      { name: GRAPH_REFRESH_TOKEN_SECRET_NAME, value: 'the-next-refresh-token' },
    ]);
    await expect(store.getRefreshToken()).resolves.toBe('the-next-refresh-token');
  });

  it('names KEY_VAULT_URL when it is missing rather than failing on a credential', () => {
    expect(() => KeyVaultTokenStore.fromEnv({})).toThrow('KEY_VAULT_URL');
  });
});

describe('InMemoryTokenStore', () => {
  it('starts empty and remembers what was set', async () => {
    const store = new InMemoryTokenStore();

    await expect(store.getRefreshToken()).resolves.toBeNull();
    await store.setRefreshToken('a-refresh-token');
    await expect(store.getRefreshToken()).resolves.toBe('a-refresh-token');
  });

  it('reads GRAPH_REFRESH_TOKEN for a local run', async () => {
    const store = InMemoryTokenStore.fromEnv({ GRAPH_REFRESH_TOKEN: 'a-developer-token' });

    await expect(store.getRefreshToken()).resolves.toBe('a-developer-token');
  });

  it('treats an unset or empty GRAPH_REFRESH_TOKEN as not connected', async () => {
    await expect(InMemoryTokenStore.fromEnv({}).getRefreshToken()).resolves.toBeNull();
    await expect(
      InMemoryTokenStore.fromEnv({ GRAPH_REFRESH_TOKEN: '' }).getRefreshToken(),
    ).resolves.toBeNull();
  });

  it('treats the placeholder as not connected', async () => {
    await expect(
      new InMemoryTokenStore(PENDING_FIRST_CONSENT).getRefreshToken(),
    ).resolves.toBeNull();
  });
});
