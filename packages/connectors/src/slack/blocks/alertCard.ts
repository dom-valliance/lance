import type { ActionsBlock, KnownBlock } from '@slack/types';
import type { Alert } from '@lance/shared';
import { ACTION } from './actions.js';
import {
  formatDateTime,
  formatTime,
  provenanceContext,
  truncate,
  type RenderedMessage,
  type RenderOptions,
} from './format.js';

function ackMuteActions(alertId: string): ActionsBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: ACTION.alertAck,
        text: { type: 'plain_text', text: 'Ack' },
        value: alertId,
      },
      {
        type: 'button',
        action_id: ACTION.alertMute,
        text: { type: 'plain_text', text: 'Mute 24h' },
        value: alertId,
      },
    ],
  };
}

/**
 * The decided-card status line for an alert that is no longer `open`. The
 * switch is exhaustive over `AlertStatus`, so a new status is a compile
 * error here until this function accounts for it.
 */
function statusLine(alert: Alert, timeZone: string): string {
  switch (alert.status) {
    case 'acked':
      return alert.ackedBy !== null && alert.ackedAt !== null
        ? `Acked by ${alert.ackedBy} at ${formatTime(alert.ackedAt, timeZone)}`
        : 'Acked';
    case 'suppressed':
      return 'Muted';
    case 'resolved':
      return 'Resolved';
    case 'open':
      throw new Error(
        'statusLine is not called for an open alert; it renders the actions block instead',
      );
  }
}

/**
 * Renders an alert card (spec 9.1). An `open` alert gets `Ack` and
 * `Mute 24h` buttons; any other status gets a status line instead, so
 * repeat alerts with the same dedupe key can update the existing message
 * (spec 9.1: "update the existing message and increment the count").
 */
export function renderAlertCard(alert: Alert, options: RenderOptions): RenderedMessage {
  const body = truncate(alert.body);

  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: alert.severity } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${alert.title}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    provenanceContext(alert.provenance),
  ];

  if (alert.count > 1) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Seen ${String(alert.count)} times, last at ${formatDateTime(alert.lastSeen, options.timeZone)}`,
        },
      ],
    });
  }

  blocks.push(
    alert.status === 'open'
      ? ackMuteActions(alert.id)
      : {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: statusLine(alert, options.timeZone) }],
        },
  );

  return {
    text: `${alert.severity} ${alert.title}`,
    blocks,
  };
}
