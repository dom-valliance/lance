import { policyRules, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { seedRules, validateRule } from '@lance/policy';
import { newUlid, nowIso, type PolicyRule } from '@lance/shared';
import { eq, sql } from 'drizzle-orm';

/** Loads the active rules from policy_rules as validated PolicyRule values. */
export async function loadActiveRules(db: Db): Promise<PolicyRule[]> {
  const rows = await db.select().from(policyRules).where(eq(policyRules.active, true));
  return rows.map((row) =>
    validateRule({
      id: row.id,
      principalId: row.principalId,
      version: row.version,
      active: row.active,
      actionClass: row.actionClass,
      counterpartyClass: row.counterpartyClass,
      system: row.system,
      decision: row.decision,
      ...(row.conditions === null ? {} : { conditions: row.conditions }),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      rationale: row.rationale,
    }),
  );
}

/** The ledger actor for the organisation defaults the worker seeds. */
export const POLICY_SEED_ACTOR = 'system:policy-seed';

/**
 * Records a `rule_changed` event, `change: recorded`, for every
 * organisation rule that has none in this scope's ledger: the rules seeded
 * before seeding recorded its own events. Dated by the rule's creation.
 */
async function recordUnrecordedRules(db: Db): Promise<number> {
  const result = await db.execute<{
    id: string;
    version: number;
    action_class: string;
    counterparty_class: string;
    system: string;
    decision: string;
    created_at: string | Date;
  }>(sql`
    SELECT r.id, r.version, r.action_class, r.counterparty_class, r.system,
           r.decision::text AS decision, r.created_at
      FROM policy_rules r
     WHERE r.principal_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_events e
                        WHERE e.kind = 'rule_changed' AND e.payload ->> 'ruleId' = r.id)
     ORDER BY r.created_at, r.id`);
  const ledger = new LedgerWriter(db);
  const correlationId = newUlid();
  for (const rule of result.rows) {
    await ledger.append({
      ts: new Date(rule.created_at).toISOString(),
      actor: POLICY_SEED_ACTOR,
      kind: 'rule_changed',
      sourceSystem: 'lance',
      sourceRecordId: rule.id,
      correlationId,
      payload: {
        change: 'recorded',
        ruleId: rule.id,
        version: Number(rule.version),
        actionClass: rule.action_class,
        counterpartyClass: rule.counterparty_class,
        system: rule.system,
        decision: rule.decision,
      },
    });
  }
  return result.rows.length;
}

/**
 * Inserts the v1 seed rules (spec 6.2) as organisation defaults when the
 * table holds none. Idempotent by id. `db` must be an admin scope: its
 * principal's ledger records one `rule_changed` event per rule, in the
 * same transaction as the rows, which is what the admin's rule-change
 * views read (ADR 0024). When the rules exist already, any organisation
 * rule without an event gets one, once.
 */
export async function ensureSeedRules(
  db: Db,
  slackChannelId: string,
): Promise<{ inserted: number; recorded: number }> {
  const existing = await db.select({ id: policyRules.id }).from(policyRules);
  if (existing.length > 0) return { inserted: 0, recorded: await recordUnrecordedRules(db) };
  const createdAt = nowIso();
  const rules = seedRules({ slackChannelId, createdAt });
  const ledger = new LedgerWriter(db);
  const correlationId = newUlid();
  await db.transaction(async (tx) => {
    for (const rule of rules) {
      await ledger.append(
        {
          ts: createdAt,
          actor: POLICY_SEED_ACTOR,
          kind: 'rule_changed',
          sourceSystem: 'lance',
          sourceRecordId: rule.id,
          correlationId,
          payload: {
            change: 'created',
            ruleId: rule.id,
            version: rule.version,
            actionClass: rule.actionClass,
            counterpartyClass: rule.counterpartyClass,
            system: rule.system,
            decision: rule.decision,
          },
        },
        tx,
      );
    }
    await tx.insert(policyRules).values(
      rules.map((rule) => ({
        id: rule.id,
        // The v1 seed rules are organisation defaults (ADR 0019), which only
        // an admin scope may write.
        principalId: null,
        version: rule.version,
        active: rule.active,
        actionClass: rule.actionClass,
        counterpartyClass: rule.counterpartyClass,
        system: rule.system,
        decision: rule.decision,
        conditions: rule.conditions ?? null,
        createdBy: rule.createdBy,
        rationale: rule.rationale,
        createdAt: new Date(rule.createdAt),
      })),
    );
  });
  return { inserted: rules.length, recorded: 0 };
}
