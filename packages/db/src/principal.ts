import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { principals, type Principal } from './schema/principals.js';

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
    throw new Error(
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
