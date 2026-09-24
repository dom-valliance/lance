/**
 * Where a signed-in person may go (ADR 0020). The api decides a principal's
 * status and refuses an onboarding principal everything but `me`; the web
 * app reads that status once at sign-in and at each id token renewal, and
 * sends an onboarding principal to the placeholder page instead of letting
 * every page fail.
 */

export const PRINCIPAL_STATUSES = ['onboarding', 'active', 'paused', 'offboarded'] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

export const ONBOARDING_PATH = '/onboarding';

const isPrincipalStatus = (value: unknown): value is PrincipalStatus =>
  typeof value === 'string' && (PRINCIPAL_STATUSES as readonly string[]).includes(value);

/**
 * The caller's principal status from the api's `me` procedure, which also
 * performs the first sign-in (binding or creating the principal). Null when
 * the api cannot be reached or answers with anything unexpected: the pages
 * then load as usual and the api's own refusal still holds.
 */
export async function fetchPrincipalStatus(
  idToken: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PrincipalStatus | null> {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/trpc/me`, {
      headers: { authorization: `Bearer ${idToken}` },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: { data?: { status?: unknown } } };
    const status = body.result?.data?.status;
    return isPrincipalStatus(status) ? status : null;
  } catch {
    return null;
  }
}

/**
 * The redirect, if any, for a request to `pathname`. An onboarding
 * principal sees only the placeholder; anyone else is sent away from it.
 * An unknown status sends nobody anywhere.
 */
export function redirectFor(
  status: PrincipalStatus | null | undefined,
  pathname: string,
): string | null {
  const onPlaceholder = pathname === ONBOARDING_PATH || pathname.startsWith(`${ONBOARDING_PATH}/`);
  if (status === 'onboarding') return onPlaceholder ? null : ONBOARDING_PATH;
  if (status !== null && status !== undefined && onPlaceholder) return '/';
  return null;
}
