'use server';

import { signOut } from '@/auth';

/** Ends the Auth.js session and lands on Today, which sends a signed-out visitor to sign in. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/today' });
}
