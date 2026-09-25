import { SYSTEM_LABELS } from '@/lib/humanise';
import { STALE_AFTER_MINUTES } from '@/lib/shell-status';

/**
 * The reading the Settings page does over the status snapshot and the
 * retention configuration (design 7.11). Pure, so the labels and the
 * connector states are tested without a render.
 */

/** The four connectors the Settings page shows, in the order it shows them. */
export type ConnectorKey = 'graph' | 'jamie' | 'notion' | 'slack';

/**
 * `healthy` and `stale` come from the newest cursor, `unknown` means the
 * watcher has never written one, and `unmonitored` is Slack, which has no
 * watcher: Lance posts to it and reads decisions from the events endpoint.
 */
export type ConnectorState = 'healthy' | 'stale' | 'unknown' | 'unmonitored';

/** The slice of a `StatusSnapshot` cursor this module reads. */
export interface ConnectorCursor {
  watcher: string;
  updatedAt: string;
  ageMinutes: number;
}

export interface ConnectorHealth {
  key: ConnectorKey;
  name: string;
  state: ConnectorState;
  /** The newest cursor's `updatedAt`, or null when nothing has been read. */
  lastReadAt: string | null;
}

/** Which watchers stand for which connector. Slack has none by design. */
const CONNECTOR_WATCHERS: Record<ConnectorKey, readonly string[]> = {
  graph: ['graph-mail', 'graph-calendar'],
  jamie: ['jamie'],
  notion: ['notion'],
  slack: [],
};

const CONNECTOR_ORDER: readonly ConnectorKey[] = ['graph', 'jamie', 'notion', 'slack'];

/**
 * The health of each connector, read from the watcher cursors in the
 * status snapshot. The threshold matches the sidebar's status line, so a
 * connector never reads stale in one place and healthy in the other.
 */
export function connectorHealth(
  snapshot: { cursors: readonly ConnectorCursor[] },
  threshold: number = STALE_AFTER_MINUTES,
): ConnectorHealth[] {
  return CONNECTOR_ORDER.map((key) => {
    const name = SYSTEM_LABELS[key];
    const watchers = CONNECTOR_WATCHERS[key];
    if (watchers.length === 0) {
      return { key, name, state: 'unmonitored', lastReadAt: null };
    }
    const newest = newestCursor(snapshot.cursors, watchers);
    if (newest === null) {
      return { key, name, state: 'unknown', lastReadAt: null };
    }
    return {
      key,
      name,
      state: newest.ageMinutes > threshold ? 'stale' : 'healthy',
      lastReadAt: newest.updatedAt,
    };
  });
}

/** The least stale cursor belonging to any of `watchers`, or null when there is none. */
function newestCursor(
  cursors: readonly ConnectorCursor[],
  watchers: readonly string[],
): ConnectorCursor | null {
  let newest: ConnectorCursor | null = null;
  for (const cursor of cursors) {
    if (!watchers.includes(cursor.watcher)) continue;
    if (newest === null || cursor.ageMinutes < newest.ageMinutes) newest = cursor;
  }
  return newest;
}

const DAYS_IN_YEAR = 365;

/**
 * A retention window in the words the reader thinks in: "90 days" up to a
 * year, "2 years" once the value is a whole number of years.
 */
export function retentionLabel(days: number): string {
  if (days >= DAYS_IN_YEAR && days % DAYS_IN_YEAR === 0) {
    const years = days / DAYS_IN_YEAR;
    return `${String(years)} year${years === 1 ? '' : 's'}`;
  }
  return `${String(days)} day${days === 1 ? '' : 's'}`;
}

/** `mailBodies` and `mail_bodies` both become "mail bodies". */
function humaniseCountKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * What the last retention run removed, read from the `retention_applied`
 * ledger payload: "41 mail bodies and 12 transcripts". The payload shape
 * is the job's to decide, so every numeric field is reported and
 * everything else is ignored; null when there is nothing to count.
 */
export function retentionRunSummary(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  // The job records its counts under `counts` (packages/ledger/src/retention.ts).
  const nested = (payload as Record<string, unknown>)['counts'];
  const counts =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? nested : payload;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const label = humaniseCountKey(key);
    if (label === '') continue;
    parts.push(`${String(value)} ${label}`);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  const last = parts[parts.length - 1] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${last}`;
}
