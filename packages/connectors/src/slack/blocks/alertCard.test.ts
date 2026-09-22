import type { ActionsBlock, ContextBlock, HeaderBlock, KnownBlock } from '@slack/types';
import { describe, expect, it } from 'vitest';
import { ACTION } from './actions.js';
import { renderAlertCard } from './alertCard.js';
import { assertWithinSlackLimits, validAlert } from './fixtures.js';
import type { RenderOptions } from './format.js';

const OPTIONS: RenderOptions = { displayName: 'Lance', timeZone: 'Europe/London' };

const contextTexts = (block: ContextBlock): string[] =>
  block.elements.flatMap((element) => ('text' in element ? [element.text] : []));

const contextBlocks = (blocks: KnownBlock[]): ContextBlock[] =>
  blocks.filter((block): block is ContextBlock => block.type === 'context');

const actionsBlocks = (blocks: KnownBlock[]): ActionsBlock[] =>
  blocks.filter((block): block is ActionsBlock => block.type === 'actions');

describe('renderAlertCard', () => {
  it('stays within Slack Block Kit structural limits', () => {
    const { blocks } = renderAlertCard(validAlert(), OPTIONS);
    expect(() => assertWithinSlackLimits(blocks)).not.toThrow();
  });

  it('renders the severity as plain text in the header', () => {
    const alert = validAlert({ severity: 'P0' });
    const { blocks } = renderAlertCard(alert, OPTIONS);
    const header = blocks.find((block): block is HeaderBlock => block.type === 'header');
    expect(header?.text).toEqual({ type: 'plain_text', text: 'P0' });
  });

  it('gives a fallback text that mentions the severity and title', () => {
    const alert = validAlert({ severity: 'P2', title: 'A stale watermark' });
    const { text } = renderAlertCard(alert, OPTIONS);
    expect(text).toContain('P2');
    expect(text).toContain('A stale watermark');
  });

  it('omits the count line when count is 1', () => {
    const { blocks } = renderAlertCard(validAlert({ count: 1 }), OPTIONS);
    const seen = contextBlocks(blocks).some((block) =>
      contextTexts(block).some((text) => text.startsWith('Seen')),
    );
    expect(seen).toBe(false);
  });

  it('shows the count line only when count is greater than 1', () => {
    const alert = validAlert({ count: 4, lastSeen: '2026-09-21T08:30:00.000Z' });
    const { blocks } = renderAlertCard(alert, OPTIONS);
    const seenBlock = contextBlocks(blocks).find((block) =>
      contextTexts(block).some((text) => text.startsWith('Seen')),
    );
    expect(seenBlock).toBeDefined();
    expect(contextTexts(seenBlock as ContextBlock)[0]).toContain('Seen 4 times, last at');
  });

  it('gives an open alert Ack and Mute 24h buttons carrying the alert id', () => {
    const alert = validAlert({ status: 'open' });
    const { blocks } = renderAlertCard(alert, OPTIONS);
    const found = actionsBlocks(blocks);
    expect(found).toHaveLength(1);
    const [ack, mute] = found[0]?.elements ?? [];
    expect((ack as { action_id?: string; value?: string }).action_id).toBe(ACTION.alertAck);
    expect((ack as { value?: string }).value).toBe(alert.id);
    expect((mute as { action_id?: string }).action_id).toBe(ACTION.alertMute);
    expect((mute as { value?: string }).value).toBe(alert.id);
  });

  it.each(['acked', 'suppressed'] as const)(
    'renders no buttons and a status line when status is %s',
    (status) => {
      const alert = validAlert({
        status,
        ackedBy: status === 'acked' ? 'user:dom' : null,
        ackedAt: status === 'acked' ? '2026-09-21T08:05:00.000Z' : null,
      });
      const { blocks } = renderAlertCard(alert, OPTIONS);
      expect(actionsBlocks(blocks)).toHaveLength(0);
      const hasStatusLine = contextBlocks(blocks).some((block) =>
        contextTexts(block).some((text) => text.length > 0),
      );
      expect(hasStatusLine).toBe(true);
    },
  );

  it('names who acked and when', () => {
    const alert = validAlert({
      status: 'acked',
      ackedBy: 'user:dom',
      ackedAt: '2026-09-21T08:05:00.000Z',
    });
    const { blocks } = renderAlertCard(alert, OPTIONS);
    const statusBlock = contextBlocks(blocks).find((block) =>
      contextTexts(block).some((text) => text.includes('Acked')),
    );
    expect(contextTexts(statusBlock as ContextBlock)[0]).toBe('Acked by user:dom at 09:05');
  });

  it('renders no provenance block when the alert has no provenance, so Slack accepts the card', () => {
    const { blocks } = renderAlertCard(validAlert({ provenance: [] }), OPTIONS);
    expect(() => assertWithinSlackLimits(blocks)).not.toThrow();
    expect(blocks.every((block) => block.type !== 'context' || block.elements.length > 0)).toBe(
      true,
    );
  });

  it('renders provenance without a url as plain text', () => {
    const alert = validAlert({
      provenance: [
        {
          system: 'jamie',
          recordId: 'meeting-1',
          hash: 'sha256:ccc',
          observedAt: '2026-09-21T08:00:00.000Z',
        },
      ],
    });
    const { blocks } = renderAlertCard(alert, OPTIONS);
    const provenance = contextBlocks(blocks).find((block) =>
      contextTexts(block).includes('jamie:meeting-1'),
    );
    expect(provenance).toBeDefined();
  });
});
