import { describe, expect, it, vi } from 'vitest';
import { createSignOutHandler } from './route';

vi.mock('@/auth', () => ({ signOut: () => Promise.resolve(undefined) }));

describe('POST /api/sign-out', () => {
  it('ends the Auth.js session and sends the visitor to the sign-in card', async () => {
    const signOut = vi.fn(() => Promise.resolve(undefined));
    const handler = createSignOutHandler({ signOut });

    const response = await handler();

    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/sign-in' });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/sign-in');
  });
});
