import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { principals, type Principal } from './schema/principals.js';

/** The principals table exists but holds no active row yet. */
class NoActivePrincipalError extends Error {}

/**
 * The principal a single-principal process acts for (ADR 0015). Phase 4
 * has one principal; each app resolves it once at start-up and scopes its
 * handle to it. Resolution per request and per job replaces this in
 * Phase 5, before a second principal is created, so a second active row
 * stops the process rather than letting it pick one.
 */
export async function resolveSinglePrincipal(db: Db, upn: string): Promise<Principal> {
  const active = await db.select().from(principals).where(eq(principals.status, 'active'));
  if (active.length === 0) {
    throw new NoActivePrincipalError(
      'No active principal in the principals table. Run the migration job, which seeds the first ' +
        'principal, before starting the apps.',
    );
  }
  if (active.length > 1) {
    throw new Error(
      `Found ${String(active.length)} active principals, and this build acts for one. Per-principal ` +
        'resolution arrives with Phase 5; until then set every principal but one to paused.',
    );
  }
  const principal = active[0]!;
  if (principal.upn.toLowerCase() !== upn.toLowerCase()) {
    throw new Error(
      `The active principal is ${principal.upn} but this process is configured for ${upn}. ` +
        'Correct ALLOWED_UPN or DOM_EMAIL, or the principal row, so the two agree.',
    );
  }
  return principal;
}

/** undefined_table: the migration that creates principals has not run yet. */
const UNDEFINED_TABLE = '42P01';

const causeChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 5) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
};

/** True for the two states a start-up that races the migration job can see. */
function isMigrationPending(error: unknown): boolean {
  return causeChain(error).some(
    (link) =>
      link instanceof NoActivePrincipalError ||
      (link as { code?: unknown }).code === UNDEFINED_TABLE,
  );
}

export interface WaitOptions {
  /** How long to keep trying, from `config.database.startupWaitSeconds`. */
  readonly waitSeconds: number;
  readonly pollSeconds?: number;
  readonly log?: (message: string) => void;
  /** Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * `resolveSinglePrincipal`, retried while the migration job has yet to
 * create the principal (ADR 0032), so an app started a moment before the
 * job finishes waits for it. Any other failure, and a wait that runs out,
 * throws at once.
 */
export async function waitForSinglePrincipal(
  db: Db,
  upn: string,
  options: WaitOptions,
): Promise<Principal> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = (options.pollSeconds ?? 10) * 1000;
  const deadline = now() + options.waitSeconds * 1000;
  for (;;) {
    try {
      return await resolveSinglePrincipal(db, upn);
    } catch (error) {
      if (!isMigrationPending(error) || now() + pollMs > deadline) throw error;
      options.log?.(
        `Waiting for the migration job to create the principal for ${upn}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(pollMs);
    }
  }
}
