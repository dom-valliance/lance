import { principals, scopedDb, slackLinks, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { lanceRolesFrom, newUlid, nowIso, type LanceRole } from '@lance/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { actorFromUpn } from '../actor.js';
import type { PrincipalDirectoryLike, PrincipalRef, VerifiedIdentity } from '../deps.js';
import { ForbiddenError } from '../errors.js';

/**
 * Identity to principal (ADR 0020). `principals` is readable by every app
 * session; the two writes a first sign-in makes are the only ones
 * `lance_app` may make there outside the principal's own scope (migration
 * 0012), and each is recorded in the ledger under the principal it
 * concerns. Inside that scope, each sign-in records the Lance roles the
 * token carries when they differ from the last ones recorded (migration
 * 0014), so a Slack command can be gated on `Lance.Admin`.
 *
 * A Slack user resolves through `slack_links` (ADR 0021): only a binding
 * the person proved through `/lance login` counts.
 */

export interface DirectoryOptions {
  /** Injected in tests. Returns an ISO-8601 instant with an explicit offset. */
  now?: () => string;
}

/** unique_violation: a concurrent first sign-in for the same account got there first. */
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const COLUMNS = {
  id: principals.id,
  upn: principals.upn,
  status: principals.status,
  slackUserId: principals.slackUserId,
  slackChannelId: principals.slackChannelId,
  lanceRoles: principals.lanceRoles,
  createdAt: principals.createdAt,
  entraOid: principals.entraOid,
};

type Row = Omit<PrincipalRef, 'lanceRoles'> & { entraOid: string | null; lanceRoles: string[] };

const toRef = (row: Row): PrincipalRef => ({
  id: row.id,
  upn: row.upn,
  status: row.status,
  slackUserId: row.slackUserId,
  slackChannelId: row.slackChannelId,
  lanceRoles: lanceRolesFrom(row.lanceRoles),
  createdAt: row.createdAt,
});

const sameRoles = (left: readonly LanceRole[], right: readonly LanceRole[]): boolean =>
  [...left].sort().join(',') === [...right].sort().join(',');

export function createPrincipalDirectory(
  root: Db,
  options: DirectoryOptions = {},
): PrincipalDirectoryLike {
  const clock = options.now ?? nowIso;

  const byOid = async (oid: string): Promise<Row | null> => {
    const rows = await root.select(COLUMNS).from(principals).where(eq(principals.entraOid, oid));
    return rows[0] ?? null;
  };

  const byUpn = async (upn: string): Promise<Row | null> => {
    const rows = await root
      .select(COLUMNS)
      .from(principals)
      .where(sql`lower(${principals.upn}) = lower(${upn})`);
    return rows[0] ?? null;
  };

  /** A state_changed event in the principal's own scope. */
  const record = async (
    principalId: string,
    identity: VerifiedIdentity,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await new LedgerWriter(scopedDb(root, { principalId })).append({
      ts: clock(),
      actor: actorFromUpn(identity.upn),
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId: newUlid(),
      payload,
    });
  };

  /** The oid lands only on a row that has none, so a bound row is never rebound. */
  const bind = async (row: Row, identity: VerifiedIdentity): Promise<PrincipalRef> => {
    const updated = await root
      .update(principals)
      .set({ entraOid: identity.oid, updatedAt: new Date(clock()) })
      .where(and(eq(principals.id, row.id), isNull(principals.entraOid)))
      .returning(COLUMNS);
    const bound = updated[0];
    if (bound === undefined) {
      const winner = await byOid(identity.oid);
      if (winner !== null) return toRef(winner);
      throw new ForbiddenError(
        `The principal for ${identity.upn} was bound to another Entra account while this sign-in ran. Ask a Lance admin to check the principals table.`,
      );
    }
    await record(bound.id, identity, {
      change: 'principal_bound',
      principalId: bound.id,
      entraOid: identity.oid,
    });
    return toRef(bound);
  };

  const create = async (identity: VerifiedIdentity): Promise<PrincipalRef> => {
    const id = newUlid();
    try {
      // Plain SQL on purpose: Drizzle names every column in an insert and
      // sends DEFAULT for the missing ones, and lance_app may insert these
      // four columns only (migration 0011).
      await root.execute(
        sql`INSERT INTO principals (id, entra_oid, upn, status) VALUES (${id}, ${identity.oid}, ${identity.upn}, 'onboarding')`,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await byOid(identity.oid);
      if (winner === null) throw error;
      return toRef(winner);
    }
    const created = await byOid(identity.oid);
    if (created === null) {
      throw new Error(
        `The onboarding principal for ${identity.upn} was inserted and then could not be read back. Check the principals policies in migration 0011.`,
      );
    }
    await record(created.id, identity, {
      change: 'principal_created',
      principalId: created.id,
      entraOid: identity.oid,
      status: 'onboarding',
    });
    return toRef(created);
  };

  /**
   * Records the token's Lance roles on the principal when they changed,
   * in the principal's own scope, with a ledger event. A paused or
   * offboarded principal keeps what was last recorded.
   */
  const recordRoles = async (
    principal: PrincipalRef,
    identity: VerifiedIdentity,
  ): Promise<PrincipalRef> => {
    const roles = [...identity.roles].sort();
    if (sameRoles(principal.lanceRoles, roles)) return principal;
    if (principal.status === 'paused' || principal.status === 'offboarded') return principal;
    const at = new Date(clock());
    await scopedDb(root, { principalId: principal.id })
      .update(principals)
      .set({ lanceRoles: roles, rolesRecordedAt: at, updatedAt: at })
      .where(eq(principals.id, principal.id));
    await record(principal.id, identity, {
      change: 'principal_roles_recorded',
      principalId: principal.id,
      roles,
      previous: principal.lanceRoles,
    });
    return { ...principal, lanceRoles: roles };
  };

  const resolve = async (identity: VerifiedIdentity): Promise<PrincipalRef> => {
    const known = await byOid(identity.oid);
    if (known !== null) return toRef(known);

    const sameUpn = await byUpn(identity.upn);
    if (sameUpn === null) return create(identity);
    if (sameUpn.entraOid === null) return bind(sameUpn, identity);
    throw new ForbiddenError(
      `A Lance principal for ${identity.upn} is already bound to a different Entra account. Ask a Lance admin to check the principals table before signing in again.`,
    );
  };

  return {
    async signIn(identity: VerifiedIdentity): Promise<PrincipalRef> {
      return recordRoles(await resolve(identity), identity);
    },

    async bySlackUserId(
      slackUserId: string,
      slackTeamId: string | null = null,
    ): Promise<PrincipalRef | null> {
      const rows = await root
        .select({ ...COLUMNS, linkTeamId: slackLinks.slackTeamId })
        .from(slackLinks)
        .innerJoin(principals, eq(principals.id, slackLinks.principalId))
        .where(and(eq(slackLinks.slackUserId, slackUserId), isNull(slackLinks.revokedAt)));
      const row = rows[0];
      if (row === undefined) return null;
      if (slackTeamId !== null && row.linkTeamId !== slackTeamId) return null;
      return toRef(row);
    },

    async bySlackChannelId(channelId: string): Promise<PrincipalRef | null> {
      const rows = await root
        .select(COLUMNS)
        .from(principals)
        .where(eq(principals.slackChannelId, channelId));
      const row = rows[0];
      return row === undefined ? null : toRef(row);
    },

    async byUpn(upn: string): Promise<PrincipalRef | null> {
      const row = await byUpn(upn);
      return row === null ? null : toRef(row);
    },

    async list(): Promise<PrincipalRef[]> {
      const rows = await root.select(COLUMNS).from(principals).orderBy(asc(principals.createdAt));
      return rows.map(toRef);
    },
  };
}
