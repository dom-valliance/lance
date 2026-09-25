import { redirect } from 'next/navigation';
import { updateSession } from '@/auth';

/**
 * `GET /onboarding/continue`: where the checklist sends a principal the api
 * no longer counts as onboarding while their session still does, for
 * example after they finished in another tab. It asks the api for their
 * status again, which the session then carries, and opens the app; without
 * it the proxy would send them straight back to the checklist.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<never> {
  await updateSession({});
  redirect('/');
}
