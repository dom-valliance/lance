import { policyRules, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { seedRules, validateRule } from '@lance/policy';
import { newUlid, nowIso, type PolicyRule } from '@lance/shared';
import { eq } from 'drizzle-orm';

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
 * Inserts the v1 seed rules (spec 6.2) as organisation defaults when the
 * table holds none. Idempotent by id. `db` must be an admin scope: its
 * principal's ledger records one `rule_changed` event per rule, in the
 * same transaction as the rows, which is what the admin's rule-change
 * views read (ADR 0024).
 */
export async function ensureSeedRules(
  db: Db,
  slackChannelId: string,
): Promise<{ inserted: number }> {
  const existing = await db.select({ id: policyRules.id }).from(policyRules);
  if (existing.length > 0) return { inserted: 0 };
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
  return { inserted: rules.length };
}
