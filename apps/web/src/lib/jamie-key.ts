/**
 * Onboarding step 3 (docs/plans/multi-user.md M3, ADR 0022): the Jamie API
 * key goes from the form to the api's `POST /credentials/jamie`, which
 * makes a test call and only then writes the key to Key Vault. The web app
 * holds the key for the length of one request and never logs it, puts it in
 * an error, or returns it; every failure here is worded without it.
 */

export interface JamieKeySubmission {
  apiKey: string;
  /** The signed-in principal's Entra id token, the api's bearer. */
  idToken: string;
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}

const NOTHING_STORED = 'Nothing was stored.';

/** The api's `{ error }` body, or null when it sent something else. */
async function apiError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error !== '' ? body.error : null;
  } catch {
    return null;
  }
}

/** Null when the key was tested and stored; otherwise the sentence to show under the form. */
export async function submitJamieKey(submission: JamieKeySubmission): Promise<string | null> {
  const apiKey = submission.apiKey.trim();
  if (apiKey === '') {
    return `Paste your personal Jamie API key before saving. ${NOTHING_STORED}`;
  }
  const fetchImpl = submission.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${submission.apiBaseUrl}/credentials/jamie`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${submission.idToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey }),
      cache: 'no-store',
    });
  } catch {
    return `The Lance api could not be reached. ${NOTHING_STORED} Try again in a minute.`;
  }
  if (response.ok) return null;
  // A 4xx carries the api's own advice, which never names the key.
  if (response.status < 500) {
    return (
      (await apiError(response)) ??
      `The api refused the key (status ${String(response.status)}). ${NOTHING_STORED}`
    );
  }
  if (response.status === 503) {
    return `Storing a Jamie key is not configured on this api yet. ${NOTHING_STORED} Ask a Lance admin.`;
  }
  return `The key could not be stored because of a fault in the api. ${NOTHING_STORED} Try again, and ask a Lance admin if it keeps happening.`;
}
