import type { KnownBlock } from '@slack/types';
import type { Alert, Proposal } from '@lance/shared';

/**
 * Fixed ULIDs for deterministic fixtures and assertions. Not minted with
 * `newUlid` because tests assert against literal ids (spec 5.1 shape:
 * 26-character Crockford base32).
 */
export const FIXTURE_PROPOSAL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const FIXTURE_ALERT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const FIXTURE_CORRELATION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

/** A valid, `pending` proposal. Pass `overrides` to vary status or fields. */
export function validProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: FIXTURE_PROPOSAL_ID,
    correlationId: FIXTURE_CORRELATION_ID,
    actionClass: 'apply_category',
    counterpartyClass: 'client',
    targetSystem: 'graph',
    targetRecordId: 'AAMkAGI2-mail-0001',
    reversibility: 'reversible',
    payload: {
      label: 'Deals',
      note: 'Filed under Deals per the seed rule.',
    },
    preview: 'Apply the "Deals" label to the mail from Acme Corp.',
    rationale: 'The seed rule auto-categorises client mail with deal language into Deals.',
    provenance: [
      {
        system: 'graph',
        recordId: 'AAMkAGI2-mail-0001',
        hash: 'sha256:abc123',
        observedAt: '2026-09-21T08:00:00.000Z',
        url: 'https://outlook.office.com/mail/id/AAMkAGI2-mail-0001',
      },
    ],
    policyDecision: 'propose',
    policyRuleId: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    editedPayload: null,
    slackChannel: 'C0BU7P278N5',
    slackTs: null,
    expiresAt: '2026-09-21T14:00:00.000Z',
    executionEventId: null,
    ...overrides,
  };
}

/** A valid, `open` alert. Pass `overrides` to vary status, count or fields. */
export function validAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: FIXTURE_ALERT_ID,
    severity: 'P1',
    kind: 'watcher_failed',
    dedupeKey: 'watcher_failed:graph:mail',
    title: 'The mail watcher has failed twice',
    body: 'The mail watcher for graph has failed on its last two runs.',
    provenance: [
      {
        system: 'graph',
        recordId: 'watcher:mail',
        hash: 'sha256:def456',
        observedAt: '2026-09-21T08:00:00.000Z',
      },
    ],
    status: 'open',
    firstSeen: '2026-09-21T07:00:00.000Z',
    lastSeen: '2026-09-21T08:00:00.000Z',
    count: 1,
    ackedBy: null,
    ackedAt: null,
    slackTs: null,
    ...overrides,
  };
}

const MAX_BLOCKS = 50;
const MAX_SECTION_TEXT = 3000;
const MAX_HEADER_TEXT = 150;

/**
 * Throws when `blocks` breaks one of the Block Kit structural limits this
 * project relies on. Used by every `*.test.ts` in this directory instead
 * of repeating the same three checks in each file.
 */
export function assertWithinSlackLimits(blocks: readonly KnownBlock[]): void {
  if (blocks.length > MAX_BLOCKS) {
    throw new Error(
      `Expected at most ${String(MAX_BLOCKS)} blocks, received ${String(blocks.length)}`,
    );
  }
  for (const block of blocks) {
    if (
      block.type === 'section' &&
      block.text !== undefined &&
      block.text.text.length > MAX_SECTION_TEXT
    ) {
      throw new Error(`Section text exceeds ${String(MAX_SECTION_TEXT)} characters`);
    }
    if (block.type === 'header' && block.text.text.length > MAX_HEADER_TEXT) {
      throw new Error(`Header text exceeds ${String(MAX_HEADER_TEXT)} characters`);
    }
  }
}
