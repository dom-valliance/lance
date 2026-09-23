import { auth } from '@/auth';
import type { NavCounts } from '@/components/shell/nav';
import { shellStatusLine, type ShellStatusLine } from '@/lib/shell-status';
import { apiClient } from '@/lib/trpc';

/**
 * What the shell shows around every page: the pending count in the
 * navigation, the health line in the sidebar and the paused banner. Each
 * read is tolerant: the shell renders with "Status unavailable" rather
 * than taking the page down with it when the api is unreachable.
 */

export interface PausedState {
  pausedAt: string | null;
  pausedBy: string | null;
  pausedReason: string | null;
}

export interface ShellData {
  /**
   * False only on the sign-in page, where the shell renders the card alone
   * on an empty canvas: no navigation, no status and no banner is readable
   * without a session.
   */
  signedIn: boolean;
  counts: NavCounts;
  statusLine: ShellStatusLine | null;
  paused: PausedState | null;
}

const EMPTY: ShellData = {
  signedIn: false,
  counts: { pendingProposals: null, openAlerts: null },
  statusLine: null,
  paused: null,
};

export async function loadShellData(): Promise<ShellData> {
  const session = await auth();
  if (session === null) return EMPTY;

  let client: Awaited<ReturnType<typeof apiClient>>;
  try {
    client = await apiClient();
  } catch {
    // Signed in, but the session carries no id token. The shell still
    // renders; it reads "Status unavailable" rather than sending the
    // reader back to the sign-in card.
    return { ...EMPTY, signedIn: true };
  }

  const [pending, status] = await Promise.all([
    client.proposals.summary.query().catch(() => null),
    client.systemState.status.query().catch(() => null),
  ]);

  return {
    signedIn: true,
    counts: { pendingProposals: pending === null ? null : pending.pending, openAlerts: null },
    statusLine: status === null ? null : shellStatusLine(status),
    paused:
      status === null || !status.paused
        ? null
        : {
            pausedAt: status.pausedAt,
            pausedBy: status.pausedBy,
            pausedReason: status.pausedReason,
          },
  };
}
