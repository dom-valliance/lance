import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import {
  FakeDirectory,
  fakeDeps,
  fakeIdentity,
  fakePrincipal,
  fakeVerifier,
  TEST_OID,
  type FakeDeps,
} from '../test-fakes.js';

/**
 * Role-gated sign-in over HTTP (ADR 0020): the token must carry a Lance
 * app role, the principal comes from its oid, and an onboarding principal
 * reaches nothing but `me`.
 */

const STRANGER_OID = 'a-stranger-oid';

let server: FastifyInstance | undefined;

const serve = (harness: FakeDeps): FastifyInstance => {
  server = buildServer(harness.server);
  return server;
};

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const harnessWith = (): FakeDeps =>
  fakeDeps({
    directory: new FakeDirectory([[TEST_OID, fakePrincipal()]]),
    auth: fakeVerifier({
      'no-role': fakeIdentity({ roles: [] }),
      user: fakeIdentity({ roles: ['Lance.User'] }),
      admin: fakeIdentity({ roles: ['Lance.User', 'Lance.Admin'] }),
      stranger: fakeIdentity({
        oid: STRANGER_OID,
        upn: 'new.person@valliance.ai',
        roles: ['Lance.User'],
      }),
    }),
  });

const trpcGet = (app: FastifyInstance, path: string, token: string) =>
  app.inject({
    method: 'GET',
    url: `/trpc/${path}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('sign-in to the api', () => {
  it('refuses a token that carries neither Lance role, before any principal is resolved', async () => {
    const harness = harnessWith();
    const response = await trpcGet(serve(harness), 'me', 'no-role');

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toContain('neither Lance app role');
    expect(harness.directory.signIns).toEqual([]);
  });

  it('lets a Lance.User reach the app as their own principal', async () => {
    const harness = harnessWith();
    const app = serve(harness);

    const me = await trpcGet(app, 'me', 'user');
    const summary = await trpcGet(app, 'proposals.summary', 'user');

    expect(me.statusCode).toBe(200);
    expect(me.json<{ result: { data: { status: string } } }>().result.data.status).toBe('active');
    expect(summary.statusCode).toBe(200);
  });

  it('lets a Lance.Admin reach the admin procedures', async () => {
    const response = await trpcGet(serve(harnessWith()), 'admin.health', 'admin');

    expect(response.statusCode).toBe(200);
  });

  it('answers 403 to a Lance.User on an admin procedure', async () => {
    const response = await trpcGet(serve(harnessWith()), 'admin.principals', 'user');

    expect(response.statusCode).toBe(403);
  });

  it('gives a stranger with a role an onboarding principal who reaches only me', async () => {
    const harness = harnessWith();
    const app = serve(harness);

    const me = await trpcGet(app, 'me', 'stranger');
    const summary = await trpcGet(app, 'proposals.summary', 'stranger');
    const pause = await app.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: { authorization: 'Bearer stranger' },
      payload: { reason: 'curious' },
    });
    const events = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { authorization: 'Bearer stranger' },
    });

    expect(me.json<{ result: { data: { status: string } } }>().result.data.status).toBe(
      'onboarding',
    );
    expect([summary.statusCode, pause.statusCode, events.statusCode]).toEqual([403, 403, 403]);
    expect(harness.control.pauseCalls).toEqual([]);
  });
});
