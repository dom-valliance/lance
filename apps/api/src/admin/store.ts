import { scopedDb, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { sql } from 'drizzle-orm';
import { COST_WINDOW_DAYS, STARTED_AT_KEY } from '../agents/view.js';
import type {
  AdminPrincipalView,
  AdminStoreLike,
  OffboardingQueued,
  OffboardingRequest,
  PrincipalDirectoryLike,
  PrincipalHealth,
  PrincipalRef,
  RuleChangeView,
  SecretState,
  SystemAlertView,
} from '../deps.js';
import { BadRequestError } from '../errors.js';
import { ONBOARDING_FACTS, onboardingProgress } from './onboarding.js';
import { ageMinutesBetween, shiftLocalDays, startOfLocalDay } from '../status.js';

/**
 * The reads behind the admin procedures (ADR 0024). Each principal's health
 * is one statement run in that principal's own scope, so row-level security
 * decides what it can see exactly as it does for the principal. The
 * statement selects ages, counts and sums; it names no column that holds
 * content, so there is nothing for a response to leak.
 */

export interface AdminStoreOptions {
  usdToGbp: number;
  timeZone: string;
  /**
   * Puts an offboarding on the worker's queue and returns the job id. The
   * worker holds the vault and Slack rights the steps need; the api does not.
   */
  enqueueOffboard: (request: {
    principalId: string;
    actor: string;
    reason: string;
  }) => Promise<string>;
  /** Injected in tests. */
  now?: () => Date;
}

/** Rule changes and system alerts the page lists, newest first. */
const LIST_LIMIT = 50;

/** The connectors whose secrets the page reports, and the changes that store them. */
const SECRET_CONNECTORS = ['graph', 'jamie'] as const;

interface SecretRow extends Record<string, unknown> {
  connector: string;
  state: 'stored' | 'deleted';
  recorded_at: string;
}

interface RuleChangeRow extends Record<string, unknown> {
  id: string;
  ts: string;
  actor: string;
  rule_id: string;
  change: string | null;
  version: number;
  active: boolean;
  action_class: string;
  counterparty_class: string;
  system: string;
  decision: string;
}

interface AlertRow extends Record<string, unknown> {
  id: string;
  severity: string;
  kind: string;
  title: string;
  status: string;
  first_seen: string;
  last_seen: string;
  count: number;
}

/** The dedupe key every `breaker_open` alert carries: `breaker:<connector>`. */
const BREAKER_PREFIX = 'breaker:';

interface HealthRow extends Record<string, unknown> {
  watchers: { watcher: string; last_run_at: string }[];
  breakers: string[];
  cost_today_usd: string;
  cost_week_usd: string;
}

const roundGbp = (value: number): number => Math.round(value * 10_000) / 10_000;

export function createAdminStore(
  root: Db,
  directory: PrincipalDirectoryLike,
  options: AdminStoreOptions,
): AdminStoreLike {
  const now = options.now ?? ((): Date => new Date());

  /** Which onboarding facts the principal's own ledger holds (see ./onboarding.ts). */
  const factsOf = async (principalId: string): Promise<Set<string>> => {
    const result = await scopedDb(root, { principalId }).execute<{ fact: string }>(sql`
      SELECT DISTINCT
        CASE WHEN payload ->> 'change' = 'credential_migrated'
             THEN 'credential_migrated:' || (payload ->> 'connector')
             ELSE payload ->> 'change' END AS fact
        FROM ledger_events
       WHERE kind = 'state_changed'
         AND payload ->> 'change' IN (${sql.join(
           [...new Set(ONBOARDING_FACTS.map((fact) => fact.split(':')[0] ?? fact))].map(
             (change) => sql`${change}`,
           ),
           sql`, `,
         )})`);
    return new Set(result.rows.map((row) => row.fact));
  };

  /** The latest record of each connector's secret: stored, or deleted at offboarding. */
  const secretsOf = async (principalId: string): Promise<SecretState[]> => {
    const result = await scopedDb(root, { principalId }).execute<SecretRow>(sql`
      SELECT DISTINCT ON (connector) connector, state, recorded_at FROM (
        SELECT id, created_at AS recorded_at, 'stored' AS state,
               CASE payload ->> 'change'
                 WHEN 'graph_connected' THEN 'graph'
                 WHEN 'jamie_connected' THEN 'jamie'
                 ELSE payload ->> 'connector' END AS connector
          FROM ledger_events
         WHERE kind = 'state_changed'
           AND payload ->> 'change' IN ('graph_connected', 'jamie_connected', 'credential_migrated')
        UNION ALL
        SELECT id, created_at, 'deleted', connector
          FROM ledger_events, unnest(ARRAY['graph', 'jamie']) AS connector
         WHERE kind = 'state_changed' AND payload ->> 'change' = 'offboarding_step'
           AND payload ->> 'step' = 'secrets' AND payload ->> 'outcome' IN ('done', 'already_done')
      ) recorded
      WHERE connector IS NOT NULL
      ORDER BY connector, id DESC`);
    return SECRET_CONNECTORS.map((connector) => {
      const row = result.rows.find((candidate) => candidate.connector === connector);
      return row === undefined
        ? { connector, state: 'never_stored' as const, recordedAt: null }
        : { connector, state: row.state, recordedAt: new Date(row.recorded_at).toISOString() };
    });
  };

  const healthOf = async (principal: PrincipalRef, at: Date): Promise<PrincipalHealth> => {
    const dayStart = startOfLocalDay(at, options.timeZone);
    const weekStart = shiftLocalDays(at, -(COST_WINDOW_DAYS - 1), options.timeZone);
    const scoped = scopedDb(root, { principalId: principal.id });
    const result = await scoped.execute<HealthRow>(sql`
      SELECT
        (SELECT coalesce(json_agg(json_build_object('watcher', w.watcher, 'last_run_at', w.last_run_at)
                                  ORDER BY w.watcher), '[]'::json)
           FROM (SELECT watcher, max(updated_at) AS last_run_at FROM cursors
                 WHERE key <> ${STARTED_AT_KEY} GROUP BY watcher) w) AS watchers,
        (SELECT coalesce(json_agg(DISTINCT dedupe_key), '[]'::json) FROM alerts
           WHERE kind = 'breaker_open' AND status = 'open'
             AND dedupe_key LIKE ${`${BREAKER_PREFIX}%`}) AS breakers,
        (SELECT coalesce(sum(estimated_cost_usd), 0)::text FROM agent_runs
           WHERE started_at >= ${dayStart.toISOString()}::timestamptz) AS cost_today_usd,
        (SELECT coalesce(sum(estimated_cost_usd), 0)::text FROM agent_runs
           WHERE started_at >= ${weekStart.toISOString()}::timestamptz) AS cost_week_usd
    `);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`The health read for principal ${principal.id} returned no row.`);
    }
    return {
      principalId: principal.id,
      upn: principal.upn,
      status: principal.status,
      watchers: row.watchers.map((watcher) => ({
        watcher: watcher.watcher,
        lastRunAgeMinutes: ageMinutesBetween(at, new Date(watcher.last_run_at)),
      })),
      breakers: row.breakers
        .map((key) => key.slice(BREAKER_PREFIX.length))
        .filter((connector) => connector !== '')
        .sort()
        .map((connector) => ({ connector, state: 'open' as const })),
      secrets: await secretsOf(principal.id),
      costTodayGbp: roundGbp(Number(row.cost_today_usd) * options.usdToGbp),
      costWeekGbp: roundGbp(Number(row.cost_week_usd) * options.usdToGbp),
    };
  };

  return {
    async principals(): Promise<AdminPrincipalView[]> {
      const all = await directory.list();
      const views: AdminPrincipalView[] = [];
      for (const principal of all) {
        views.push({
          id: principal.id,
          upn: principal.upn,
          status: principal.status,
          createdAt: principal.createdAt.toISOString(),
          onboarding: onboardingProgress(await factsOf(principal.id)),
        });
      }
      return views;
    },

    async health(): Promise<PrincipalHealth[]> {
      const at = now();
      const all = await directory.list();
      const health: PrincipalHealth[] = [];
      for (const principal of all) {
        if (principal.status === 'offboarded') continue;
        health.push(await healthOf(principal, at));
      }
      return health;
    },

    async ruleChanges(): Promise<RuleChangeView[]> {
      const all = await directory.list();
      const changes: RuleChangeView[] = [];
      for (const principal of all) {
        // Organisation rules (principal_id null) are readable from every
        // scope; the event lives in the ledger of the admin who made it.
        const result = await scopedDb(root, { principalId: principal.id }).execute<RuleChangeRow>(
          sql`
          SELECT e.id, e.ts, e.actor, r.id AS rule_id, e.payload ->> 'change' AS change,
                 r.version, r.active, r.action_class, r.counterparty_class, r.system,
                 r.decision::text AS decision
            FROM ledger_events e
            JOIN policy_rules r ON r.id = e.payload ->> 'ruleId' AND r.principal_id IS NULL
           WHERE e.kind = 'rule_changed'
           ORDER BY e.id DESC
           LIMIT ${LIST_LIMIT}`,
        );
        for (const row of result.rows) {
          changes.push({
            eventId: row.id,
            ts: new Date(row.ts).toISOString(),
            actor: row.actor,
            ruleId: row.rule_id,
            change: row.change,
            rule: {
              version: Number(row.version),
              active: row.active,
              actionClass: row.action_class,
              counterpartyClass: row.counterparty_class,
              system: row.system,
              decision: row.decision,
            },
          });
        }
      }
      return changes
        .sort((a, b) => (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0))
        .slice(0, LIST_LIMIT);
    },

    async systemAlerts(adminPrincipalId: string): Promise<SystemAlertView[]> {
      // Only alerts an organisation job (a `system:` actor) raised, in the
      // admin's own scope: never an alert of another principal.
      const result = await scopedDb(root, { principalId: adminPrincipalId }).execute<AlertRow>(sql`
        SELECT a.id, a.severity::text AS severity, a.kind, a.title, a.status::text AS status,
               a.first_seen, a.last_seen, a.count
          FROM alerts a
         WHERE a.status IN ('open', 'acked')
           AND EXISTS (SELECT 1 FROM ledger_events e
                        WHERE e.kind = 'alert_raised' AND e.actor LIKE 'system:%'
                          AND e.payload ->> 'alertId' = a.id)
         ORDER BY a.last_seen DESC
         LIMIT ${LIST_LIMIT}`);
      return result.rows.map((row) => ({
        id: row.id,
        severity: row.severity,
        kind: row.kind,
        title: row.title,
        status: row.status,
        firstSeen: new Date(row.first_seen).toISOString(),
        lastSeen: new Date(row.last_seen).toISOString(),
        count: Number(row.count),
      }));
    },

    async requestOffboarding(request: OffboardingRequest): Promise<OffboardingQueued> {
      if (request.principalId === request.callerId) {
        throw new BadRequestError(
          'An admin cannot offboard themselves from the admin page. Ask another Lance admin, or follow docs/runbooks/offboard-principal.md.',
        );
      }
      const target = (await directory.list()).find(
        (principal) => principal.id === request.principalId,
      );
      if (target === undefined) {
        throw new BadRequestError(
          `No principal has id ${request.principalId}. Take the id from the principals list on this page.`,
        );
      }
      await new LedgerWriter(scopedDb(root, { principalId: target.id, admin: true })).append({
        ts: nowIso(),
        actor: request.actor,
        kind: 'state_changed',
        sourceSystem: 'lance',
        correlationId: newUlid(),
        payload: {
          change: 'offboarding_requested',
          principalId: target.id,
          from: target.status,
          reason: request.reason,
        },
      });
      const jobId = await options.enqueueOffboard({
        principalId: target.id,
        actor: request.actor,
        reason: request.reason,
      });
      return { status: 'queued', principalId: target.id, jobId };
    },
  };
}
