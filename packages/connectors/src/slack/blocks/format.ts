import type { ContextBlock, KnownBlock, MrkdwnElement } from '@slack/types';
import type { ProvenanceRef } from '@lance/shared';

/**
 * Formatting helpers shared by every renderer in `blocks/`. Kept here
 * rather than duplicated in `proposalCard.ts`, `executedCard.ts` and
 * `alertCard.ts` (CLAUDE.md: prefer composition, no magic numbers
 * repeated in three places).
 */

/** Display options every renderer in this directory accepts. */
export interface RenderOptions {
  /** The agent's configured display name (`AGENT_DISPLAY_NAME`, root CLAUDE.md). */
  displayName: string;
  /** IANA time zone the viewer's timestamps are shown in, e.g. `Europe/London`. */
  timeZone: string;
}

/** What every renderer returns: a Slack message with its notification fallback. */
export interface RenderedMessage {
  text: string;
  blocks: KnownBlock[];
}

/** U+00B7 MIDDLE DOT, used to separate chips (spec 9.1: no em dash). */
const MIDDLE_DOT = '·';

/**
 * `*apply_category*  ·  client`: the action class and counterparty class
 * chip line (spec 9.1: "Slack has no chips; render as a context block").
 */
export function chipLine(actionClass: string, counterpartyClass: string): string {
  return `*${actionClass}*  ${MIDDLE_DOT}  ${counterpartyClass}`;
}

/** `action_class / counterparty_class / system`: the footer policy cell. */
export function policyCell(actionClass: string, counterpartyClass: string, system: string): string {
  return `${actionClass} / ${counterpartyClass} / ${system}`;
}

const TRUNCATE_AT = 2900;
const TRUNCATION_MARKER = ' (truncated)';

/**
 * Truncates `value` at 2900 characters and appends a marker, keeping the
 * result comfortably under Slack's 3000-character section text limit
 * (spec 9.1: preview truncation).
 */
export function truncate(value: string, maxLength = TRUNCATE_AT): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}${TRUNCATION_MARKER}`;
}

/** Slack context blocks allow at most 10 elements. */
const MAX_CONTEXT_ELEMENTS = 10;

function provenanceText(ref: ProvenanceRef): string {
  const label = `${ref.system}:${ref.recordId}`;
  return ref.url === undefined ? label : `<${ref.url}|${label}>`;
}

/**
 * Provenance as a context block of links: `<url|system:recordId>` when a
 * url is present, plain `system:recordId` otherwise (spec 9.1, non-negotiable 5).
 * Returns no block at all when there is no provenance: Slack rejects a
 * context block with no elements as `invalid_blocks`, and one such card
 * opens the connector's breaker for every card behind it.
 */
export function provenanceContext(provenance: readonly ProvenanceRef[]): ContextBlock[] {
  if (provenance.length === 0) return [];
  const elements: MrkdwnElement[] = provenance
    .slice(0, MAX_CONTEXT_ELEMENTS)
    .map((ref) => ({ type: 'mrkdwn', text: provenanceText(ref) }));
  return [{ type: 'context', elements }];
}

/** `HH:MM` in `timeZone`, 24-hour, e.g. `09:14`. */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** A medium date and short time in `timeZone`, e.g. `21 Sep 2026, 14:00`. */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}
