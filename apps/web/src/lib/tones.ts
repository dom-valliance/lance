import type { LedgerKind, ProposalStatus, SourceSystem } from '@/lib/filters';
import type { CommitmentStatus } from '@/lib/commitment-view';

/**
 * The six semantic hues of the design foundations (section 3) plus the
 * neutral pair and the two special cases. Every badge, dot and accent bar
 * in the UI picks a hue through one of the mappings below, so a status is
 * coloured the same way on every page. Colour is never the only signal:
 * every badge carries a text label as well.
 */
export type Tone =
  | 'blue'
  | 'pink'
  | 'peach'
  | 'teal'
  | 'green'
  | 'red'
  | 'neutral'
  /** Neutral fill with full-strength text (the Notion badge). */
  | 'neutral-strong'
  /** Hairline only, muted text (expired, webhook). */
  | 'outline'
  /** The one solid fill in the system, reserved for P0. */
  | 'solid-red';

export const PROPOSAL_STATUS_TONES: Record<ProposalStatus, Tone> = {
  pending: 'peach',
  held: 'pink',
  approved: 'blue',
  edited: 'blue',
  executing: 'teal',
  executed: 'green',
  rejected: 'neutral',
  expired: 'outline',
  failed: 'red',
};

export const SYSTEM_TONES: Record<SourceSystem, Tone> = {
  graph: 'blue',
  jamie: 'pink',
  notion: 'neutral-strong',
  slack: 'teal',
  lance: 'peach',
  webhook: 'outline',
};

export type AlertSeverity = 'P0' | 'P1' | 'P2';

export const SEVERITY_TONES: Record<AlertSeverity, Tone> = {
  P0: 'solid-red',
  P1: 'peach',
  P2: 'blue',
};

export type PolicyDecision = 'forbid' | 'propose' | 'auto';

export const DECISION_TONES: Record<PolicyDecision, Tone> = {
  forbid: 'red',
  propose: 'peach',
  auto: 'green',
};

export const COMMITMENT_STATUS_TONES: Record<CommitmentStatus | 'overdue', Tone> = {
  open: 'blue',
  chased: 'peach',
  done: 'green',
  dropped: 'neutral',
  overdue: 'red',
};

export type WatcherState = 'healthy' | 'stale' | 'breaker_open' | 'paused';

export const WATCHER_STATE_TONES: Record<WatcherState, Tone> = {
  healthy: 'green',
  stale: 'peach',
  breaker_open: 'red',
  paused: 'neutral',
};

/**
 * Dot colour on a ledger timeline (design foundations, section 8): grey
 * for the mechanical kinds, peach for what Lance put forward or raised,
 * blue for what Dom decided or a rule change, green for executed, red for
 * failed. The kind label is always printed beside the dot.
 */
export const LEDGER_KIND_TONES: Record<LedgerKind, Tone> = {
  observed: 'neutral',
  resolved: 'neutral',
  proposed: 'peach',
  decided: 'blue',
  executed: 'green',
  failed: 'red',
  alert_raised: 'peach',
  alert_acked: 'peach',
  rule_changed: 'blue',
  state_changed: 'neutral',
  retention_applied: 'neutral',
  cost_recorded: 'neutral',
};

/** The Tailwind class that paints a dot or a bar in a tone's text colour. */
export const TONE_DOT_CLASS: Record<Tone, string> = {
  blue: 'bg-sem-blue-fg',
  pink: 'bg-sem-pink-fg',
  peach: 'bg-sem-peach-fg',
  teal: 'bg-sem-teal-fg',
  green: 'bg-sem-green-fg',
  red: 'bg-sem-red-fg',
  neutral: 'bg-sem-neutral-fg',
  'neutral-strong': 'bg-foreground',
  outline: 'bg-sem-neutral-fg',
  'solid-red': 'bg-sem-red-fg',
};

/** The Tailwind class that colours text in a tone. */
export const TONE_TEXT_CLASS: Record<Tone, string> = {
  blue: 'text-sem-blue-fg',
  pink: 'text-sem-pink-fg',
  peach: 'text-sem-peach-fg',
  teal: 'text-sem-teal-fg',
  green: 'text-sem-green-fg',
  red: 'text-sem-red-fg',
  neutral: 'text-sem-neutral-fg',
  'neutral-strong': 'text-foreground',
  outline: 'text-sem-neutral-fg',
  'solid-red': 'text-sem-red-fg',
};
