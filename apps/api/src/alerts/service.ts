import { renderAlertCard } from '@lance/connectors';
import type { Alert } from '@lance/db';
import { toAlert } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { TRPCError } from '@trpc/server';
import { DOM_ACTOR, type ApiDeps } from '../deps.js';
import type { AlertCountQuery } from './store.js';
import { toAlertView, type AlertView } from './view.js';

/**
 * What the Alerts page asks for (spec 12): the list, one alert, and the
 * three state changes Dom makes from the page or from a Slack card. Every
 * change appends a ledger event before the card is redrawn, so an alert's
 * status can always be traced back to who changed it and when
 * (non-negotiable 1); spec 11 says a mute is itself a ledger event.
 */

export type AlertDeps = Pick<
  ApiDeps,
  'alerts' | 'writer' | 'slackSurface' | 'config' | 'notify' | 'now' | 'onAlertSlackFailure'
>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The mute window a card button or the page may ask for. */
export const MIN_MUTE_HOURS = 1;
export const MAX_MUTE_HOURS = 168;

const HOUR_MS = 60 * 60 * 1000;

/** A muted alert can be muted again, which extends the window. */
const MUTABLE_FROM: Alert['status'][] = ['open', 'acked', 'suppressed'];
const RESOLVABLE_FROM: Alert['status'][] = ['open', 'acked'];

export interface ListAlertsInput {
  status?: Alert['status'] | undefined;
  severity?: Alert['severity'] | undefined;
  kind?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface AlertPage {
  items: AlertView[];
  nextCursor: string | null;
  /** Every alert the filters match, across all pages. */
  total: number;
}

export async function listAlerts(deps: AlertDeps, input: ListAlertsInput): Promise<AlertPage> {
  const size = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const filter: AlertCountQuery = {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.severity === undefined ? {} : { severity: input.severity }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  };
  // One row beyond the page tells us whether a next page exists; the count
  // runs beside it over the same filters, without the cursor.
  const [rows, total] = await Promise.all([
    deps.alerts.list({
      ...filter,
      limit: size + 1,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
    deps.alerts.count(filter),
  ]);
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return { items: page.map(toAlertView), nextCursor, total };
}

export async function getAlert(deps: AlertDeps, id: string): Promise<AlertView | null> {
  const row = await deps.alerts.get(id);
  return row === null ? null : toAlertView(row);
}

/** Reads the alert the caller named, or says where to find a real id. */
async function mustRead(deps: AlertDeps, id: string): Promise<Alert> {
  const row = await deps.alerts.get(id);
  if (row === null) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Alert ${id} does not exist. Check the id on the Alerts page.`,
    });
  }
  return row;
}

/** The row after a transition the store may have lost to a concurrent one. */
function settled(row: Alert | null, id: string, to: Alert['status']): Alert {
  if (row === null) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Alert ${id} changed while it was being marked ${to}. Reload the page and try again.`,
    });
  }
  return row;
}

export interface AlertActionInput {
  id: string;
  /** The ledger actor, derived from the verified UPN by the router. */
  actor?: string;
}

/**
 * Acknowledges an alert. An alert that is already acked is left alone and
 * no second event is written, so a double click cannot double-write the
 * ledger.
 */
export async function ackAlert(deps: AlertDeps, input: AlertActionInput): Promise<AlertView> {
  const ts = (deps.now ?? nowIso)();
  const actor = input.actor ?? DOM_ACTOR;
  const existing = await mustRead(deps, input.id);
  if (existing.status === 'acked') return toAlertView(existing);
  if (existing.status !== 'open') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Alert ${input.id} is ${existing.status}, so it cannot be acknowledged. Only an open alert can be acked.`,
    });
  }

  const updated = settled(
    await deps.alerts.setStatus({
      id: input.id,
      from: ['open'],
      to: 'acked',
      at: new Date(ts),
      ackedBy: actor,
    }),
    input.id,
    'acked',
  );

  await deps.writer.append({
    ts,
    actor,
    kind: 'alert_acked',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: { alertId: input.id, kind: existing.kind, dedupeKey: existing.dedupeKey },
  });

  return await settle(deps, updated);
}

export interface MuteAlertInput extends AlertActionInput {
  hours: number;
}

/**
 * Suppresses the alert's dedupe key for the window (spec 11). The mute is
 * itself a ledger event, so a channel that has gone quiet can be explained
 * from the ledger alone.
 */
export async function muteAlert(deps: AlertDeps, input: MuteAlertInput): Promise<AlertView> {
  const ts = (deps.now ?? nowIso)();
  const actor = input.actor ?? DOM_ACTOR;
  const existing = await mustRead(deps, input.id);
  if (!MUTABLE_FROM.includes(existing.status)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Alert ${input.id} is ${existing.status}, so it cannot be muted. Only an open, acked or already muted alert can be.`,
    });
  }

  const mutedUntil = new Date(new Date(ts).getTime() + input.hours * HOUR_MS);
  const updated = settled(
    await deps.alerts.setStatus({
      id: input.id,
      from: MUTABLE_FROM,
      to: 'suppressed',
      at: new Date(ts),
      mutedUntil,
    }),
    input.id,
    'suppressed',
  );

  await deps.writer.append({
    ts,
    actor,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: {
      kind: 'alert_status',
      alertId: input.id,
      from: existing.status,
      to: 'suppressed',
      mutedUntil: mutedUntil.toISOString(),
    },
  });

  return await settle(deps, updated);
}

/** Closes the alert. A repeat resolve is a no-op, as a repeat ack is. */
export async function resolveAlert(deps: AlertDeps, input: AlertActionInput): Promise<AlertView> {
  const ts = (deps.now ?? nowIso)();
  const actor = input.actor ?? DOM_ACTOR;
  const existing = await mustRead(deps, input.id);
  if (existing.status === 'resolved') return toAlertView(existing);
  if (!RESOLVABLE_FROM.includes(existing.status)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Alert ${input.id} is ${existing.status}, so it cannot be resolved. Unmute it first.`,
    });
  }

  const updated = settled(
    await deps.alerts.setStatus({
      id: input.id,
      from: RESOLVABLE_FROM,
      to: 'resolved',
      at: new Date(ts),
    }),
    input.id,
    'resolved',
  );

  await deps.writer.append({
    ts,
    actor,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: {
      kind: 'alert_status',
      alertId: input.id,
      from: existing.status,
      to: 'resolved',
    },
  });

  return await settle(deps, updated);
}

/** Redraws the Slack card, tells the live feed, and returns the view. */
async function settle(deps: AlertDeps, row: Alert): Promise<AlertView> {
  await updateCard(deps, row);
  deps.notify({ type: 'alert', id: row.id });
  return toAlertView(row);
}

/**
 * Redraws the card in place, for an alert that was posted to Slack. The
 * state change has already landed by the time this runs, so a Slack failure
 * is reported rather than thrown: losing the reply would leave the caller
 * retrying a change it already made.
 */
async function updateCard(deps: AlertDeps, row: Alert): Promise<void> {
  if (deps.slackSurface === null || row.slackTs === null) return;

  const card = renderAlertCard(toAlert(row), {
    displayName: deps.config.agentDisplayName,
    timeZone: deps.config.timeZone,
  });

  try {
    await deps.slackSurface.update(
      { ts: row.slackTs, text: card.text, blocks: card.blocks },
      { request: { alertId: row.id } },
    );
  } catch (error) {
    deps.onAlertSlackFailure?.(error, row.id);
  }
}
