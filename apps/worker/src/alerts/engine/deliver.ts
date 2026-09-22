import { renderAlertCard, type SlackSurface } from '@lance/connectors';
import { alerts, type Alert as AlertRow, type Db } from '@lance/db';
import { LedgerWriter, toAlert } from '@lance/ledger';
import { nowIso, type Config } from '@lance/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { recordPush, remainingPushes } from './budget.js';
import { isQuiet, nextQuietEnd } from './hours.js';

/**
 * Delivery (spec 9.4, 11): every minute the engine looks at open alerts
 * that Slack has not seen and decides. P0 posts at once, quiet hours or
 * not. P1 posts in working hours, otherwise waits for the next 07:00. P2
 * is never pushed; the next brief or board carries it. Repeats update the
 * existing message and its count. Pushes beyond the hourly budget are
 * folded into one "and N more" post that links to the Alerts page.
 */

export const DELIVERY_ACTOR = 'system:alerts';

export interface DeliverDeps {
  db: Db;
  config: Pick<Config, 'timeZone' | 'interruption' | 'agentDisplayName'>;
  slack: Pick<SlackSurface, 'post' | 'update'> | null;
  /** Where the Alerts page lives, for the overflow post. */
  webUrl: string | null;
  now?: () => string;
}

export interface DeliveryResult {
  posted: string[];
  updated: string[];
  deferred: string[];
  batched: string[];
}

/** Open P0 and P1 alerts Slack has not seen and that are not muted. */
async function pendingAlerts(db: Db, at: string): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.status, 'open'),
        isNull(alerts.slackTs),
        inArray(alerts.severity, ['P0', 'P1']),
        or(isNull(alerts.mutedUntil), sql`${alerts.mutedUntil} < ${new Date(at)}`),
      ),
    )
    .orderBy(asc(alerts.severity), asc(alerts.firstSeen));
}

/** Alerts already in Slack whose count rose since the card was last drawn. */
async function repeatedAlerts(db: Db): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.status, 'open'),
        sql`${alerts.slackTs} is not null`,
        // raiseAlert sets last_seen and updated_at to the same instant on a
        // repeat; delivery moves updated_at past last_seen once the card is
        // drawn. Equal therefore means "raised since the last draw".
        sql`${alerts.lastSeen} >= ${alerts.updatedAt}`,
      ),
    );
}

export async function deliverAlerts(deps: DeliverDeps): Promise<DeliveryResult> {
  const now = deps.now ?? nowIso;
  const at = now();
  const result: DeliveryResult = { posted: [], updated: [], deferred: [], batched: [] };
  if (deps.slack === null) return result;
  const render = { displayName: deps.config.agentDisplayName, timeZone: deps.config.timeZone };
  const quiet = isQuiet(at, deps.config.timeZone, deps.config.interruption);

  const pending = await pendingAlerts(deps.db, at);
  const due = pending.filter((row) => row.severity === 'P0' || !quiet);
  result.deferred = pending.filter((row) => !due.includes(row)).map((row) => row.id);

  let allowance = await remainingPushes({
    db: deps.db,
    perHour: deps.config.interruption.pushBudgetPerHour,
    now,
  });
  const overflow: AlertRow[] = [];
  for (const row of due) {
    // P0 pierces the budget as it pierces quiet hours (spec 9.4).
    if (row.severity !== 'P0' && allowance <= 0) {
      overflow.push(row);
      continue;
    }
    const card = renderAlertCard(toAlert(row), render);
    const posted = await deps.slack.post(
      { text: card.text, blocks: card.blocks },
      { correlationId: row.id },
    );
    await deps.db
      .update(alerts)
      .set({ slackTs: posted.ts, updatedAt: new Date(at) })
      .where(eq(alerts.id, row.id));
    await recordPush(deps.db, { reason: 'alert', slackTs: posted.ts, ids: [row.id], now });
    allowance -= 1;
    result.posted.push(row.id);
  }

  if (overflow.length > 0) {
    // One post for the rest, counted once against the budget it exceeded.
    const titles = overflow.slice(0, 3).map((row) => `${row.severity} ${row.title}`);
    const rest = overflow.length - titles.length;
    const link = deps.webUrl === null ? '' : ` <${deps.webUrl}/alerts|Open the Alerts page>`;
    const text = `${String(overflow.length)} more alert${overflow.length === 1 ? '' : 's'} held back by the hourly push budget: ${titles.join('; ')}${rest > 0 ? ` and ${String(rest)} more` : ''}.${link}`;
    const posted = await deps.slack.post({ text }, { correlationId: overflow[0]?.id ?? '' });
    await deps.db
      .update(alerts)
      .set({ slackTs: posted.ts, updatedAt: new Date(at) })
      .where(
        inArray(
          alerts.id,
          overflow.map((row) => row.id),
        ),
      );
    await recordPush(deps.db, {
      reason: 'alert_batch',
      slackTs: posted.ts,
      ids: overflow.map((row) => row.id),
      now,
    });
    result.batched = overflow.map((row) => row.id);
  }

  for (const row of await repeatedAlerts(deps.db)) {
    if (row.slackTs === null) continue;
    const card = renderAlertCard(toAlert(row), render);
    await deps.slack.update({ ts: row.slackTs, text: card.text, blocks: card.blocks });
    await deps.db
      .update(alerts)
      .set({ updatedAt: new Date(at) })
      .where(eq(alerts.id, row.id));
    result.updated.push(row.id);
  }

  if (result.posted.length + result.batched.length > 0) {
    await new LedgerWriter(deps.db).append({
      ts: at,
      actor: DELIVERY_ACTOR,
      kind: 'resolved',
      sourceSystem: 'slack',
      correlationId: result.posted[0] ?? result.batched[0] ?? '',
      payload: {
        kind: 'alerts_delivered',
        posted: result.posted,
        batched: result.batched,
        deferred: result.deferred,
        quiet,
        nextQuietEnd: quiet
          ? nextQuietEnd(at, deps.config.timeZone, deps.config.interruption)
          : null,
      },
    });
  }
  return result;
}
