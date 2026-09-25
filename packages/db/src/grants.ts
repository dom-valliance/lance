import { pathToFileURL } from 'node:url';
import { createDb, type CreateDbOptions, type Db } from './client.js';

/**
 * Role memberships the migration job grants after the migrations and the
 * seed (docs/runbooks/deploy.md step 9, ADR 0011).
 *
 * The worker's database identity joins `lance_retention` so the nightly
 * retention job can null ledger payloads. The grant is made WITH INHERIT
 * FALSE, SET TRUE: the identity gains none of the role's privileges in an
 * ordinary session, which always runs as `lance_app` (`PG_ROLE`), and can
 * use them only by an explicit `SET LOCAL ROLE lance_retention` inside the
 * retention transaction. `lance_app` itself is never a member, so no app
 * session can null a payload.
 *
 * The migrate identity may make the grant because it created
 * `lance_retention` in migration 0000, and PostgreSQL 16 gives a role's
 * creator the ADMIN option on it.
 */

/** A Postgres role name as Azure names a managed identity's principal. */
const ROLE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

/** Roles that must never hold lance_retention (ADR 0011). */
const REFUSED = new Set(['lance_app', 'lance_migrator', 'public']);

export const RETENTION_MEMBER_ENV = 'LANCE_RETENTION_MEMBER';

export type GrantOutcome =
  { status: 'granted'; role: string } | { status: 'skipped'; reason: string };

/** Grants `lance_retention` to `member` for SET ROLE only. Repeating it changes nothing. */
export async function grantRetentionMember(db: Db, member: string): Promise<GrantOutcome> {
  if (!ROLE_NAME.test(member)) {
    throw new Error(
      `${RETENTION_MEMBER_ENV} must be a Postgres role name (letters, digits, hyphens, full stops, underscores); got "${member}".`,
    );
  }
  if (REFUSED.has(member.toLowerCase())) {
    throw new Error(
      `${member} may not be a member of lance_retention: only the worker's own identity is (ADR 0011). Set ${RETENTION_MEMBER_ENV} to the worker identity's name.`,
    );
  }
  const exists = await db.$client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [
    member,
  ]);
  if (exists.rowCount === 0) {
    throw new Error(
      `No Postgres role named "${member}". Create the worker identity's principal first (docs/runbooks/deploy.md step 7), then run the migration job again.`,
    );
  }
  const quoted = `"${member.replace(/"/g, '""')}"`;
  await db.$client.query(`GRANT lance_retention TO ${quoted} WITH INHERIT FALSE, SET TRUE`);
  return { status: 'granted', role: member };
}

/** The job's step: grants the member named in the environment, or says why it did not. */
export async function runGrants(
  options: CreateDbOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<GrantOutcome> {
  const member = env[RETENTION_MEMBER_ENV];
  if (member === undefined || member === '') {
    return {
      status: 'skipped',
      reason: `${RETENTION_MEMBER_ENV} is not set, so no identity was granted lance_retention and the retention job cannot null payloads in this database.`,
    };
  }
  const db = createDb(options);
  try {
    return await grantRetentionMember(db, member);
  } finally {
    await db.$client.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const outcome = await runGrants();
  console.info(
    outcome.status === 'granted'
      ? `Granted lance_retention to ${outcome.role} for SET ROLE only.`
      : `Grants skipped: ${outcome.reason}`,
  );
}
