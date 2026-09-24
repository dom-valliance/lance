import { describe, expect, it, vi } from 'vitest';
import { fetchPrincipalStatus, redirectFor } from './principal';

const answering = (status: number, body: unknown) =>
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

describe('fetchPrincipalStatus', () => {
  it("reads the principal's status from the api's me procedure with the id token as bearer", async () => {
    const fetchImpl = answering(200, { result: { data: { status: 'onboarding' } } });

    await expect(fetchPrincipalStatus('id-token', 'http://api', fetchImpl)).resolves.toBe(
      'onboarding',
    );
    expect(fetchImpl).toHaveBeenCalledWith('http://api/trpc/me', {
      headers: { authorization: 'Bearer id-token' },
      cache: 'no-store',
    });
  });

  it('reads a refusal or an unknown status as no status', async () => {
    await expect(fetchPrincipalStatus('t', 'http://api', answering(403, {}))).resolves.toBeNull();
    await expect(
      fetchPrincipalStatus(
        't',
        'http://api',
        answering(200, { result: { data: { status: 'x' } } }),
      ),
    ).resolves.toBeNull();
  });

  it('reads an unreachable api as no status', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(fetchPrincipalStatus('t', 'http://api', failing)).resolves.toBeNull();
  });
});

describe('redirectFor', () => {
  it('sends an onboarding principal to the placeholder from every other page', () => {
    expect(redirectFor('onboarding', '/today')).toBe('/onboarding');
    expect(redirectFor('onboarding', '/onboarding')).toBeNull();
  });

  it('lets an onboarding principal start the Microsoft 365 consent and sign out', () => {
    expect(redirectFor('onboarding', '/api/graph/connect')).toBeNull();
    expect(redirectFor('onboarding', '/api/sign-out')).toBeNull();
    expect(redirectFor('onboarding', '/onboarding/continue')).toBeNull();
    expect(redirectFor('onboarding', '/api/events')).toBe('/onboarding');
  });

  it('lets an active principal reach the app and sends them away from the placeholder', () => {
    expect(redirectFor('active', '/today')).toBeNull();
    expect(redirectFor('active', '/onboarding')).toBe('/');
  });

  it('redirects nobody while the status is unknown', () => {
    expect(redirectFor(null, '/today')).toBeNull();
    expect(redirectFor(undefined, '/onboarding')).toBeNull();
  });
});
