import { beforeAll, describe, expect, it } from 'vitest';
import { createAccessTokenProvider } from './accessToken.js';
import { createGraphConnector } from './client.js';
import { createGraphReads, type GraphReads } from './reads.js';
import { InMemoryTokenStore } from './tokenStore.js';

/**
 * Live tests against Dom's real tenant (spec 8: "Live tests behind
 * `LIVE_CONNECTOR_TESTS=1`"). They read and nothing else: no draft, no
 * category, no move, no hold. Without the flag the whole suite is
 * skipped, so `pnpm test` stays hermetic.
 *
 * Running one rotates the refresh token in the tenant, because Entra
 * rotates it on every use. The new value is held in memory and lost when
 * the process exits, so set `GRAPH_REFRESH_TOKEN` from a scratch consent
 * rather than from the value Key Vault holds for the deployed Lance.
 */

const REQUIRED = [
  'GRAPH_REFRESH_TOKEN',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
] as const;

const enabled = process.env['LIVE_CONNECTOR_TESTS'] === '1';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `LIVE_CONNECTOR_TESTS=1 needs ${REQUIRED.join(', ')} in the environment; ${name} is not set. See docs/runbooks/entra-setup.md.`,
    );
  }
  return value;
}

describe.skipIf(!enabled)('the Graph connector against the live tenant', () => {
  let reads: GraphReads;

  beforeAll(() => {
    reads = createGraphReads(
      createGraphConnector({
        accessToken: createAccessTokenProvider({
          store: new InMemoryTokenStore(requireEnv('GRAPH_REFRESH_TOKEN')),
          tenantId: requireEnv('ENTRA_TENANT_ID'),
          clientId: requireEnv('ENTRA_CLIENT_ID'),
          clientSecret: requireEnv('ENTRA_CLIENT_SECRET'),
        }),
      }),
    );
  });

  it('lists the mailbox folders, including an Inbox', async () => {
    const folders = await reads.listMailFolders();

    expect(folders.length).toBeGreaterThan(0);
    expect(folders.map((folder) => folder.displayName)).toContain('Inbox');
  });

  it('lists the Outlook master categories', async () => {
    const categories = await reads.listCategories();

    expect(Array.isArray(categories)).toBe(true);
    for (const category of categories) {
      expect(typeof category.id).toBe('string');
    }
  });
});
