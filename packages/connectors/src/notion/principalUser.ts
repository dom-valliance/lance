import type { NotionUserSummary } from './types.js';

/**
 * Finding a principal's Notion user (ADR 0022, docs/plans/multi-user.md
 * M2). Notion stays one organisation integration, so each principal is
 * told apart in the shared All Tasks database by their Notion user id,
 * resolved from the workspace users list by the principal's email.
 *
 * Matching is by exact email, ignoring case. Two people with the same
 * email is not a match: a wrong id would put somebody else's tasks in a
 * brief, so the ambiguity is reported and the id stays unset.
 */

export type NotionUserMatch =
  | { status: 'matched'; notionUserId: string }
  | { status: 'unmatched' }
  | { status: 'ambiguous'; candidates: number };

export function matchNotionUserByEmail(
  users: readonly NotionUserSummary[],
  email: string,
): NotionUserMatch {
  const wanted = email.trim().toLowerCase();
  const hits = users.filter((user) => user.email?.trim().toLowerCase() === wanted);
  if (hits.length === 1) return { status: 'matched', notionUserId: hits[0]!.id };
  if (hits.length === 0) return { status: 'unmatched' };
  return { status: 'ambiguous', candidates: hits.length };
}

export interface ResolveNotionUserOptions {
  /** The principal's UPN, which is their email in the Valliance tenant. */
  email: string;
  /** What `principals.notion_user_id` holds now. */
  current: string | null;
  /** The workspace users, for example `listUsers` over the organisation integration. */
  listUsers: () => Promise<readonly NotionUserSummary[]>;
  /** Stores a newly matched id. Called only when `current` was null and one user matched. */
  save: (notionUserId: string) => Promise<void>;
}

export type NotionUserResolution =
  | { status: 'known'; notionUserId: string }
  | { status: 'resolved'; notionUserId: string }
  | { status: 'unmatched' }
  | { status: 'ambiguous'; candidates: number };

/**
 * Returns the principal's Notion user id, resolving and saving it when it
 * is not known yet. The onboarding checklist (package 5.5) and the
 * worker's connector lookup both call this; neither lists users when the
 * id is already known.
 */
export async function resolveNotionUserId(
  options: ResolveNotionUserOptions,
): Promise<NotionUserResolution> {
  if (options.current !== null && options.current !== '') {
    return { status: 'known', notionUserId: options.current };
  }
  const match = matchNotionUserByEmail(await options.listUsers(), options.email);
  if (match.status !== 'matched') return match;
  await options.save(match.notionUserId);
  return { status: 'resolved', notionUserId: match.notionUserId };
}
