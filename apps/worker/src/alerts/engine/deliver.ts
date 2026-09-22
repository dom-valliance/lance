import { renderAlertCard, renderProposalCard, type SlackSurface } from '@lance/connectors';
import { alerts, proposals, type Alert as AlertRow, type Db } from '@lance/db';
import { LedgerWriter, toAlert, toProposal } from '@lance/ledger';
import { newUlid, nowIso, type Config } from '@lance/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { recordPush, remainingPushes } from './budget.js';
import { isQuiet, nextQuietEnd } from './hours.js';

/**
 * Delivery (spec 9.4, 11): every minute the engine looks at open alerts
 * that Slack has not seen and decides. P0 posts at once, quiet hours or
 * not, paused or not. P1 posts in working hours, otherwise waits for the
 * next 07:00. P2 is never pushed; the next brief or board carries it.
 * Repeats update the existing card and its count. Pushes beyond the hourly
 * budget are folded into one "and N more" post that links to the Alerts
 * page. Proposal cards the budget held back at creation are posted here
 * once the hour allows.
 */

export const DELIVERY_ACTOR = 'system:alerts';

export interface DeliverDeps {
  db: Db;
  config: Pick<Config, 'timeZone' | 'interruption' | 'agentDisplayName'>;
  slack: Pick<SlackSurface, 'post' | 'update'> | null;
  /** Where the Alerts page lives, for the overflow post. */
  webUrl: string | null;
  /** While the kill switch is on only P0 goes out (non-negotiable 7: reads continue, writes stop, and a P0 is how Dom learns why). */
  paused?: boolean;
  now?: () => string;
}

export interface DeliveryResult {
  posted: string[];
  updated: string[];
  deferred: string[];
  batched: string[];
  proposalCards: string[];
}

/** Open P0 and P1 alerts Slack has not seen, as a card or in a batch, and that are not muted. */
async function pendingAlerts(db: Db, at: string): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.status, 'open'),
        isNull(alerts.slackTs),
        isNull(alerts.batchTs),
        inArray(alerts.severity, ['P0', 'P1']),
        or(isNull(alerts.mutedUntil), sql`${alerts.mutedUntil} < ${new Date(at)}`),
      ),
    )
    .orderBy(asc(alerts.severity), asc(alerts.firstSeen));
}

/** Alerts with a card of their own whose count rose since the card was last drawn. Acked cards are redrawn too, so the count Dom sees is right. */
async function repeatedAlerts(db: Db): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .where(
      and(
        inArray(alerts.status, ['open', 'acked']),
        sql`${alerts.slackTs} is not null`,
        sql`${alerts.slackTs} not like ${`${CLAIM_PREFIX}%`}`,
        // raiseAlert sets last_seen and updated_at to the same instant on a
        // repeat; delivery moves updated_at past last_seen once the card is
        // drawn. Equal therefore means "raised since the last draw".
        sql`${alerts.lastSeen} >= ${alerts.updatedAt}`,
      ),
    );
}

/** A row is claimed before its post so two delivery ticks cannot both post it. */
const CLAIM_PREFIX = 'claim:';

async function claimAlert(db: Db, id: string): Promise<boolean> {
  const claimed = await db
    .update(alerts)
    .set({ slackTs: `${CLAIM_PREFIX}${newUlid()}` })
    .where(and(eq(alerts.id, id), isNull(alerts.slackTs), isNull(alerts.batchTs)))
    .returning({ id: alerts.id });
  return claimed.length === 1;
}

async function releaseAlert(db: Db, id: string): Promise<void> {
  await db
    .update(alerts)
    .set({ slackTs: null })
    .where(and(eq(alerts.id, id), sql`${alerts.slackTs} like ${`${CLAIM_PREFIX}%`}`));
}

async function claimProposal(db: Db, id: string): Promise<boolean> {
  const claimed = await db
    .update(proposals)
    .set({ slackTs: `${CLAIM_PREFIX}${newUlid()}` })
    .where(and(eq(proposals.id, id), isNull(proposals.slackTs), eq(proposals.status, 'pending')))
    .returning({ id: proposals.id });
  return claimed.length === 1;
}

async function releaseProposal(db: Db, id: string): Promise<void> {
  await db
    .update(proposals)
    .set({ slackTs: null })
    .where(and(eq(proposals.id, id), sql`${proposals.slackTs} like ${`${CLAIM_PREFIX}%`}`));
}

export async function deliverAlerts(deps: DeliverDeps): Promise<DeliveryResult> {
  const now = deps.now ?? nowIso;
  const at = now();
  const paused = deps.paused ?? false;
  const result: DeliveryResult = {
    posted: [],
    updated: [],
    deferred: [],
    batched: [],
    proposalCards: [],
  };
  if (deps.slack === null) return result;
  const slack = deps.slack;
  const render = { displayName: deps.config.agentDisplayName, timeZone: deps.config.timeZone };
  const quiet = isQuiet(at, deps.config.timeZone, deps.config.interruption);

  const pending = await pendingAlerts(deps.db, at);
  const due = pending.filter((row) => row.severity === 'P0' || (!quiet && !paused));
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
    if (!(await claimAlert(deps.db, row.id))) continue;
    const card = renderAlertCard(toAlert(row), render);
    let posted: { ts: string };
    try {
      posted = await slack.post(
        { text: card.text, blocks: card.blocks },
        { correlationId: row.id },
      );
    } catch (error) {
      await releaseAlert(deps.db, row.id);
      throw error;
    }
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
    // The rows record the shared post in batch_ts, never in slack_ts: they
    // have no card to redraw.
    const titles = overflow.slice(0, 3).map((row) => `${row.severity} ${row.title}`);
    const rest = overflow.length - titles.length;
    const link = deps.webUrl === null ? '' : ` <${deps.webUrl}/alerts|Open the Alerts page>`;
    const text = `${String(overflow.length)} more alert${overflow.length === 1 ? '' : 's'} held back by the hourly push budget: ${titles.join('; ')}${rest > 0 ? ` and ${String(rest)} more` : ''}.${link}`;
    const posted = await slack.post({ text }, { correlationId: overflow[0]?.id ?? '' });
    await deps.db
      .update(alerts)
      .set({ batchTs: posted.ts, updatedAt: new Date(at) })
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
    allowance -= 1;
    result.batched = overflow.map((row) => row.id);
  }

  for (const row of await repeatedAlerts(deps.db)) {
    if (row.slackTs === null) continue;
    const card = renderAlertCard(toAlert(row), render);
    await slack.update({ ts: row.slackTs, text: card.text, blocks: card.blocks });
    await deps.db
      .update(alerts)
      .set({ updatedAt: new Date(at) })
      .where(eq(alerts.id, row.id));
    result.updated.push(row.id);
  }

  // Proposal cards the budget held back when the proposal was created.
  if (!paused && !quiet) {
    const held = await deps.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.status, 'pending'), isNull(proposals.slackTs)))
      .orderBy(asc(proposals.createdAt));
    for (const row of held) {
      if (allowance <= 0) break;
      if (!(await claimProposal(deps.db, row.id))) continue;
      const card = renderProposalCard(toProposal(row), render);
      let posted: { channel: string; ts: string };
      try {
        posted = await slack.post(
          { text: card.text, blocks: card.blocks },
          { correlationId: row.correlationId, proposalId: row.id },
        );
      } catch (error) {
        await releaseProposal(deps.db, row.id);
        throw error;
      }
      await deps.db
        .update(proposals)
        .set({ slackChannel: posted.channel, slackTs: posted.ts, updatedAt: new Date(at) })
        .where(eq(proposals.id, row.id));
      await recordPush(deps.db, {
        reason: 'proposal_card',
        correlationId: row.correlationId,
        slackTs: posted.ts,
        ids: [row.id],
        now,
      });
      allowance -= 1;
      result.proposalCards.push(row.id);
    }
  }

  if (result.posted.length + result.batched.length + result.proposalCards.length > 0) {
    await new LedgerWriter(deps.db).append({
      ts: at,
      actor: DELIVERY_ACTOR,
      kind: 'resolved',
      sourceSystem: 'slack',
      correlationId: result.posted[0] ?? result.batched[0] ?? result.proposalCards[0] ?? '',
      payload: {
        kind: 'alerts_delivered',
        posted: result.posted,
        batched: result.batched,
        deferred: result.deferred,
        proposalCards: result.proposalCards,
        quiet,
        paused,
        nextQuietEnd: quiet
          ? nextQuietEnd(at, deps.config.timeZone, deps.config.interruption)
          : null,
      },
    });
  }
  return result;
}
