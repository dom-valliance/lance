import { beforeAll, describe, expect, it } from 'vitest';
import type { TokenVerifier } from '../deps.js';
import { UnauthorisedError } from '../errors.js';
import { createTestJwks, TEST_UPN, type TestJwks } from '../test-fakes.js';
import { createEntraVerifier, entraIssuer } from './entra.js';

const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = '66666666-7777-8888-9999-000000000000';
const ISSUER = entraIssuer(TENANT_ID);

let keys: TestJwks;
let verifier: TokenVerifier;

beforeAll(async () => {
  keys = await createTestJwks(ISSUER, CLIENT_ID);
  verifier = createEntraVerifier({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    allowedUpn: TEST_UPN,
    jwks: keys.jwks,
  });
});

const rejectionMessage = async (token: string): Promise<string> => {
  try {
    await verifier.verify(token);
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorisedError);
    return (error as Error).message;
  }
  throw new Error('Expected the verifier to reject this token, and it accepted it.');
};

describe('createEntraVerifier', () => {
  it('accepts a token signed by the tenant keys for the allowlisted user', async () => {
    const token = await keys.sign({ preferred_username: TEST_UPN });
    await expect(verifier.verify(token)).resolves.toEqual({ upn: TEST_UPN });
  });

  it('matches the allowlisted UPN case-insensitively', async () => {
    const token = await keys.sign({ preferred_username: 'Dom@Valliance.AI' });
    await expect(verifier.verify(token)).resolves.toEqual({ upn: 'Dom@Valliance.AI' });
  });

  it('falls back to the upn claim when preferred_username is absent', async () => {
    const token = await keys.sign({ upn: TEST_UPN });
    await expect(verifier.verify(token)).resolves.toEqual({ upn: TEST_UPN });
  });

  it('does not accept the unverified email claim on its own', async () => {
    const token = await keys.sign({ email: TEST_UPN });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorisedError);
  });

  it('rejects a token without an expiry', async () => {
    const token = await keys.sign({ preferred_username: TEST_UPN }, { omitExpiry: true });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorisedError);
  });

  it('rejects a token issued for a different application', async () => {
    const token = await keys.sign(
      { preferred_username: TEST_UPN },
      { audience: 'another-client-id' },
    );
    await expect(rejectionMessage(token)).resolves.toContain('different application');
  });

  it('rejects a token issued by a different tenant', async () => {
    const token = await keys.sign(
      { preferred_username: TEST_UPN },
      { issuer: entraIssuer('99999999-9999-9999-9999-999999999999') },
    );
    await expect(rejectionMessage(token)).resolves.toContain('different tenant');
  });

  it('rejects an expired token', async () => {
    const token = await keys.sign(
      { preferred_username: TEST_UPN },
      { expiresAt: Math.floor(Date.now() / 1000) - 60 },
    );
    await expect(rejectionMessage(token)).resolves.toContain('expired');
  });

  it('rejects a token for a user who is not on the allowlist', async () => {
    const token = await keys.sign({ preferred_username: 'someone.else@valliance.ai' });
    await expect(rejectionMessage(token)).resolves.toContain('not on the Lance allowlist');
  });

  it('rejects a token carrying no identity claim', async () => {
    const token = await keys.sign({ oid: 'an-object-id' });
    await expect(rejectionMessage(token)).resolves.toContain('cannot tell who is calling');
  });

  it('rejects a token signed by a key the tenant does not publish', async () => {
    const stranger = await createTestJwks(ISSUER, CLIENT_ID);
    const token = await stranger.sign({ preferred_username: TEST_UPN });
    await expect(rejectionMessage(token)).resolves.toMatch(/signature|readable/);
  });

  it('rejects an empty bearer without mentioning the token', async () => {
    const message = await rejectionMessage('');
    expect(message).toContain('No bearer token');
  });

  it('never echoes the token back in a rejection', async () => {
    const token = await keys.sign({ preferred_username: 'someone.else@valliance.ai' });
    const message = await rejectionMessage(token);
    expect(message).not.toContain(token);
  });

  it('builds the single-tenant v2.0 issuer', () => {
    expect(entraIssuer(TENANT_ID)).toBe(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`);
  });
});
