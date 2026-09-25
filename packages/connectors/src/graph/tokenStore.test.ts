import { describe, expect, it } from 'vitest';
import { InMemorySecrets, KeyVaultSecrets, type SecretClientLike } from '../secrets/index.js';
import {
  graphRefreshTokenSecretName,
  InMemoryTokenStore,
  PENDING_FIRST_CONSENT,
  PrincipalTokenStore,
  principalTokenWriter,
} from './tokenStore.js';

const DOM = '01K5S9V6QW3SWCCPVB0N0E300H';
const COLLEAGUE = '01K5S9V6QW3SWCCPVB0N0E301B';

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

describe('PrincipalTokenStore', () => {
  it("reads the principal's own graph-refresh-token--<principalId> secret", async () => {
    const client = new FakeSecretClient('a-stored-refresh-token');
    const store = new PrincipalTokenStore(new KeyVaultSecrets(client), DOM);

    await expect(store.getRefreshToken()).resolves.toBe('a-stored-refresh-token');
    expect(client.reads).toEqual([`graph-refresh-token--${DOM}`]);
  });

  it('returns null when the secret still holds the pending-first-consent placeholder', async () => {
    const store = new PrincipalTokenStore(
      new KeyVaultSecrets(new FakeSecretClient(PENDING_FIRST_CONSENT)),
      DOM,
    );
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('returns null when the secret does not exist yet', async () => {
    const store = new PrincipalTokenStore(
      new KeyVaultSecrets(new FakeSecretClient(notFound())),
      DOM,
    );
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('rethrows a vault failure that is not a missing secret', async () => {
    const store = new PrincipalTokenStore(
      new KeyVaultSecrets(
        new FakeSecretClient(Object.assign(new Error('Forbidden'), { statusCode: 403 })),
      ),
      DOM,
    );
    await expect(store.getRefreshToken()).rejects.toThrow('Forbidden');
  });

  it("writes a rotated token to the principal's secret alone", async () => {
    const secrets = new InMemorySecrets();
    await new PrincipalTokenStore(secrets, COLLEAGUE).setRefreshToken('the-next-refresh-token');

    expect(secrets.writes).toEqual([
      { name: `graph-refresh-token--${COLLEAGUE}`, value: 'the-next-refresh-token' },
    ]);
    await expect(new PrincipalTokenStore(secrets, DOM).getRefreshToken()).resolves.toBeNull();
  });

  it('refuses a principal id that is not a ULID', () => {
    expect(() => new PrincipalTokenStore(new InMemorySecrets(), 'dom@valliance.ai')).toThrow(
      /ULID/,
    );
  });
});

describe('principalTokenWriter', () => {
  it("sets the caller's own secret and offers no way to read it", async () => {
    const secrets = new InMemorySecrets();
    const writer = principalTokenWriter(secrets, DOM);
    await writer.setRefreshToken('first-refresh-token');

    expect(secrets.writes).toEqual([
      { name: graphRefreshTokenSecretName(DOM), value: 'first-refresh-token' },
    ]);
    expect(Object.keys(writer)).toEqual(['setRefreshToken']);
  });
});

describe('InMemoryTokenStore', () => {
  it('starts empty and keeps the last token written', async () => {
    const store = new InMemoryTokenStore();
    await expect(store.getRefreshToken()).resolves.toBeNull();
    await store.setRefreshToken('rotated');
    await expect(store.getRefreshToken()).resolves.toBe('rotated');
  });

  it('reads GRAPH_REFRESH_TOKEN for a developer run', async () => {
    const store = InMemoryTokenStore.fromEnv({ GRAPH_REFRESH_TOKEN: 'a-developer-token' });
    await expect(store.getRefreshToken()).resolves.toBe('a-developer-token');
  });

  it('treats an unset or empty GRAPH_REFRESH_TOKEN, or the placeholder, as not connected', async () => {
    await expect(InMemoryTokenStore.fromEnv({}).getRefreshToken()).resolves.toBeNull();
    await expect(
      InMemoryTokenStore.fromEnv({ GRAPH_REFRESH_TOKEN: '' }).getRefreshToken(),
    ).resolves.toBeNull();
    await expect(
      new InMemoryTokenStore(PENDING_FIRST_CONSENT).getRefreshToken(),
    ).resolves.toBeNull();
  });
});
