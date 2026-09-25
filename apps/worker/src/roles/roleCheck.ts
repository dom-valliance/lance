import { ledgerEvents, principals, scopedDb, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import {
  hashRecord,
  idempotencyKey,
  LANCE_ROLE_IDS,
  LANCE_ROLES,
  newUlid,
  nowIso,
  type LanceRole,
} from '@lance/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { raiseAlert } from '../alerts/raise.js';

/**
 * The nightly role check (ADR 0020, docs/plans/multi-user.md M1). Entra
 * stops a person without a Lance app role at their next sign-in; this
 * catches the principal who never signs in again but whose watchers and
 * jobs keep running. It lists who holds each Lance role through Graph with
 * the app's own client credentials, and pauses, through an admin scope,
 * every active or onboarding principal who holds neither, with a ledger
 * event and a P1 alert for each admin. Pausing an onboarding principal
 * stops their prefill too.
 *
 * The roles are assigned to users directly on the enterprise application:
 * the tenant has no Entra ID P1, so a group cannot hold an app role. The
 * one Graph application permission the check needs is admin-consented by
 * `scripts/entra/setup-app-roles.sh`'s printed commands:
 *   Application.Read.All       GET /servicePrincipals(appId=...)/appRoleAssignedTo
 * Should a group ever be assigned a role (a tenant with P1), the check
 * counts its transitive user members, which needs one more permission:
 *   GroupMember.ReadBasic.All  GET /groups/{id}/transitiveMembers
 *
 * Scheduled as the locked organisation job `role-check`, nightly at 02:30
 * London, in `apps/worker/src/jobs/registry.ts` (ADR 0025).
 */

export const ROLE_CHECK_ACTOR = 'system:role-check';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface RoleCheckCredentials {
  tenantId: string;
  /** The Lance app registration's client id; the service principal is addressed by it. */
  clientId: string;
  /** `ENTRA_CLIENT_SECRET`. Never logged. */
  clientSecret: string;
}

/**
 * Offboarding by the role check (package 5.6). A principal the check paused
 * who still holds neither role `afterDays` later is offboarded: the first
 * night only pauses, so a mistaken group change costs nothing but a pause.
 */
export interface RoleCheckOffboarding {
  afterDays: number;
  run: (request: { principalId: string; actor: string; reason: string }) => Promise<unknown>;
}

export interface RoleCheckOptions {
  /** Unscoped. The check scopes each read and write itself. */
  root: Db;
  credentials: RoleCheckCredentials;
  /** Absent, the check pauses and never offboards. */
  offboarding?: RoleCheckOffboarding;
  /** Injected in tests; msw intercepts the global fetch either way. */
  fetchImpl?: typeof fetch;
  now?: () => string;
}

export interface RoleCheckResult {
  /** Entra object ids holding each role: direct user assignments, and any group's members. */
  holders: Record<LanceRole, string[]>;
  paused: { principalId: string; upn: string }[];
  /** Active or onboarding principals with no Entra object id yet, so nothing to check them against. */
  unbound: string[];
  /** Admin principals alerted, once per paused principal. */
  alerted: string[];
  /** Principals paused by an earlier check who still hold no role and were offboarded. */
  offboarded: string[];
}

const TokenSchema = z.object({ access_token: z.string().min(1) });

const AssignmentPageSchema = z.object({
  value: z.array(
    z.object({
      principalId: z.string().min(1),
      principalType: z.string(),
      appRoleId: z.string(),
    }),
  ),
  '@odata.nextLink': z.string().url().optional(),
});

const MemberPageSchema = z.object({
  value: z.array(z.object({ '@odata.type': z.string().optional(), id: z.string().min(1) })),
  '@odata.nextLink': z.string().url().optional(),
});

const USER_TYPE = '#microsoft.graph.user';

/** The statuses the check examines: anyone whose watchers, jobs or prefill may run. */
const CHECKED_STATUSES = ['active', 'onboarding'] as const;

/** A Graph read that failed, named so the operator knows which permission to check. */
export class RoleCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleCheckError';
  }
}

const appToken = async (credentials: RoleCheckCredentials, fetchImpl: typeof fetch) => {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
  );
  const parsed = TokenSchema.safeParse(await response.json().catch(() => ({})));
  if (!response.ok || !parsed.success) {
    throw new RoleCheckError(
      `Entra refused the role check's client credentials (HTTP ${String(response.status)}). Check ENTRA_CLIENT_SECRET and that it has not expired (docs/runbooks/rotate-secrets.md).`,
    );
  }
  return parsed.data.access_token;
};

/** Every page of a Graph collection, following `@odata.nextLink`. */
const readAll = async <T>(
  firstUrl: string,
  token: string,
  schema: z.ZodType<{ value: T[]; '@odata.nextLink'?: string | undefined }>,
  fetchImpl: typeof fetch,
  permission: string,
): Promise<T[]> => {
  const items: T[] = [];
  let url: string | undefined = firstUrl;
  while (url !== undefined) {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new RoleCheckError(
        `Graph answered HTTP ${String(response.status)} to the role check's read of ${new URL(url).pathname}. Check that ${permission} is granted with admin consent (docs/runbooks/entra-setup.md section 8).`,
      );
    }
    const page = schema.parse(await response.json());
    items.push(...page.value);
    url = page['@odata.nextLink'];
  }
  return items;
};

/**
 * Who holds each Lance role: every user assigned it directly, and every
 * user in a group assigned it. Groups are read only when one is assigned.
 */
export async function listRoleHolders(
  credentials: RoleCheckCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<LanceRole, string[]>> {
  const token = await appToken(credentials, fetchImpl);
  const assignments = await readAll(
    `${GRAPH}/servicePrincipals(appId='${credentials.clientId}')/appRoleAssignedTo?$select=principalId,principalType,appRoleId`,
    token,
    AssignmentPageSchema,
    fetchImpl,
    'Application.Read.All',
  );

  const holders: Record<LanceRole, Set<string>> = {
    'Lance.User': new Set(),
    'Lance.Admin': new Set(),
  };
  const groupMembers = new Map<string, string[]>();
  for (const role of LANCE_ROLES) {
    for (const assignment of assignments.filter((a) => a.appRoleId === LANCE_ROLE_IDS[role])) {
      if (assignment.principalType === 'User') {
        holders[role].add(assignment.principalId);
        continue;
      }
      if (assignment.principalType !== 'Group') continue;
      let members = groupMembers.get(assignment.principalId);
      if (members === undefined) {
        const page = await readAll(
          `${GRAPH}/groups/${assignment.principalId}/transitiveMembers?$select=id`,
          token,
          MemberPageSchema,
          fetchImpl,
          'GroupMember.ReadBasic.All (needed only because a group is assigned a Lance role)',
        );
        members = page.filter((m) => m['@odata.type'] === USER_TYPE).map((m) => m.id);
        groupMembers.set(assignment.principalId, members);
      }
      for (const member of members) holders[role].add(member);
    }
  }
  return {
    'Lance.User': [...holders['Lance.User']].sort(),
    'Lance.Admin': [...holders['Lance.Admin']].sort(),
  };
}

/**
 * One observation per checked principal of the roles they hold. The
 * idempotency key carries the hash of the result, so a night whose answer
 * matches the last one records nothing new (non-negotiable 6).
 */
const recordObservation = async (
  root: Db,
  principalId: string,
  oid: string,
  roles: LanceRole[],
  ts: string,
): Promise<void> => {
  const record = { oid, roles };
  const hash = hashRecord(record);
  await new LedgerWriter(scopedDb(root, { principalId })).append({
    ts,
    actor: ROLE_CHECK_ACTOR,
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: `role-assignment:${oid}`,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('graph', `role-assignment:${oid}`, hash),
    correlationId: newUlid(),
    payload: { kind: 'role_assignment', ...record },
  });
};

export async function runRoleCheck(options: RoleCheckOptions): Promise<RoleCheckResult> {
  const clock = options.now ?? nowIso;
  const holders = await listRoleHolders(options.credentials, options.fetchImpl ?? fetch);
  const anyRole = new Set([...holders['Lance.User'], ...holders['Lance.Admin']]);
  const admins = new Set(holders['Lance.Admin']);

  // An empty answer is a misconfiguration (a lost consent, the wrong app),
  // not a night on which everyone left. Refuse rather than pause them all.
  if (anyRole.size === 0) {
    throw new RoleCheckError(
      'Graph reports nobody holding a Lance app role, so the role check paused nobody. Check the Lance.User and Lance.Admin user assignments on the Lance enterprise application (docs/runbooks/entra-setup.md section 8).',
    );
  }

  const checked = await options.root
    .select({
      id: principals.id,
      upn: principals.upn,
      entraOid: principals.entraOid,
      status: principals.status,
    })
    .from(principals)
    .where(inArray(principals.status, CHECKED_STATUSES));

  const result: RoleCheckResult = {
    holders,
    paused: [],
    unbound: [],
    alerted: [],
    offboarded: [],
  };
  const adminPrincipals = checked.filter(
    (p) => p.status === 'active' && p.entraOid !== null && admins.has(p.entraOid),
  );

  for (const principal of checked) {
    if (principal.entraOid === null) {
      result.unbound.push(principal.id);
      continue;
    }
    const ts = clock();
    const roles = LANCE_ROLES.filter((role) => holders[role].includes(principal.entraOid ?? ''));
    await recordObservation(options.root, principal.id, principal.entraOid, roles, ts);
    if (roles.length > 0) continue;

    const admin = scopedDb(options.root, { principalId: principal.id, admin: true });
    const updated = await admin
      .update(principals)
      .set({ status: 'paused', updatedAt: new Date(ts) })
      .where(and(eq(principals.id, principal.id), eq(principals.status, principal.status)))
      .returning({ statusChangedAt: principals.statusChangedAt });
    const pause = updated[0];
    if (pause === undefined) continue;

    const correlationId = newUlid();
    await new LedgerWriter(admin).append({
      ts,
      actor: ROLE_CHECK_ACTOR,
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId,
      payload: {
        change: 'principal_paused',
        principalId: principal.id,
        reason: 'holds neither Lance app role',
        from: principal.status,
        // The database's stamp of this pause; offboarding waits while it stands.
        statusChangedAt: pause.statusChangedAt?.toISOString() ?? null,
      },
    });
    result.paused.push({ principalId: principal.id, upn: principal.upn });

    for (const recipient of adminPrincipals) {
      await raiseAlert(scopedDb(options.root, { principalId: recipient.id }), {
        kind: 'principal_access_revoked',
        severity: 'P1',
        dedupeKey: `principal_access_revoked:${principal.id}`,
        title: `${principal.upn} has lost Lance access and is paused`,
        body: `The nightly role check found that ${principal.upn} holds neither Lance.User nor Lance.Admin in Entra, so Lance paused them. Their watchers and jobs stop${principal.status === 'onboarding' ? ', and so does their onboarding prefill' : ''}. If the removal was a mistake, give them the Lance.User role again with scripts/entra/grant-access.sh and set their status to ${principal.status}.`,
        actor: ROLE_CHECK_ACTOR,
        correlationId,
        now: () => ts,
      });
      result.alerted.push(recipient.id);
    }
  }

  if (options.offboarding !== undefined) {
    result.offboarded = await offboardLapsed(options.root, options.offboarding, anyRole, clock());
  }
  return result;
}

const PauseStampSchema = z.object({ statusChangedAt: z.string().nullable().optional() });

/** The role check's latest pause of this principal, from their own ledger; null if it never paused them. */
const latestCheckPause = async (
  root: Db,
  principalId: string,
): Promise<{ ts: Date; statusChangedAt: string | null } | null> => {
  const rows = await scopedDb(root, { principalId, admin: true })
    .select({ ts: ledgerEvents.ts, payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.kind, 'state_changed'),
        eq(ledgerEvents.actor, ROLE_CHECK_ACTOR),
        sql`${ledgerEvents.payload} ->> 'change' = 'principal_paused'`,
      ),
    )
    .orderBy(desc(ledgerEvents.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const stamp = PauseStampSchema.safeParse(row.payload);
  return {
    ts: row.ts,
    statusChangedAt: stamp.success ? (stamp.data.statusChangedAt ?? null) : null,
  };
};

/**
 * Whether the principal's status is still the one the check's pause set.
 * A pause recorded before migration 0020 carries no stamp, and stands only
 * while the row has no stamp either, which means no status change since.
 */
const pauseStands = (
  pause: { statusChangedAt: string | null },
  statusChangedAt: Date | null,
): boolean =>
  statusChangedAt === null
    ? pause.statusChangedAt === null
    : pause.statusChangedAt === statusChangedAt.toISOString();

/**
 * Offboards every principal the check paused at least `afterDays` ago who
 * still holds no role and whose status has not changed since that pause:
 * a later pause by an admin, or a resume and a pause, starts no clock here.
 */
async function offboardLapsed(
  root: Db,
  offboarding: RoleCheckOffboarding,
  anyRole: ReadonlySet<string>,
  ts: string,
): Promise<string[]> {
  const paused = await root
    .select({
      id: principals.id,
      entraOid: principals.entraOid,
      statusChangedAt: principals.statusChangedAt,
    })
    .from(principals)
    .where(eq(principals.status, 'paused'));
  const offboarded: string[] = [];
  const now = Date.parse(ts);
  for (const principal of paused) {
    if (principal.entraOid === null || anyRole.has(principal.entraOid)) continue;
    const pause = await latestCheckPause(root, principal.id);
    if (pause === null || !pauseStands(pause, principal.statusChangedAt)) continue;
    const days = (now - pause.ts.getTime()) / (24 * 3600 * 1000);
    if (days < offboarding.afterDays) continue;
    await offboarding.run({
      principalId: principal.id,
      actor: ROLE_CHECK_ACTOR,
      reason: `held neither Lance app role for ${String(Math.floor(days))} days after the role check paused them`,
    });
    offboarded.push(principal.id);
  }
  return offboarded;
}
