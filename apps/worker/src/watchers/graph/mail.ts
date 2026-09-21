import {
  MessageSchema,
  type GraphReads,
  type Message,
  type Recipient,
} from '@lance/connectors/graph';
import { nowIso } from '@lance/shared';
import type { Observation, PollResult, SourceRecord, Watcher } from '../types.js';

/**
 * The `graph-mail` watcher (spec 7.1): Inbox and Sent Items by Graph delta,
 * one observation per message, one Haiku label call per message. Everything
 * except the label call is deterministic.
 *
 * Nothing here logs a subject, a body or an address. The canonical record
 * carries them into the ledger, which is the only place they belong.
 */

export const GRAPH_MAIL_WATCHER_NAME = 'graph-mail';

/**
 * Spec 7.1: "every 10 min 07:00 to 19:00 UK weekdays, hourly otherwise".
 * Three expressions rather than two so the off-hours entries do not overlap
 * the weekday daytime one; an overlap would fire two polls in the same
 * minute and spend two Graph calls to reach the same cursor. Registered with
 * the configured time zone, so the hours are UK hours.
 */
export const GRAPH_MAIL_SCHEDULES = [
  '*/10 7-18 * * 1-5',
  '0 0-6,19-23 * * 1-5',
  '0 * * * 0,6',
] as const;

export const MAIL_FOLDER_KINDS = ['inbox', 'sentitems'] as const;
/** Which side of the mailbox a watched folder sits on. Graph's well-known folder names. */
export type MailFolderKind = (typeof MAIL_FOLDER_KINDS)[number];

export interface MailFolderSpec {
  /** Folder id, and the watcher's partition key. A well-known name works as an id. */
  id: string;
  kind: MailFolderKind;
}

/**
 * Graph accepts the well-known names `inbox` and `sentitems` wherever a
 * folder id is accepted, so the default costs no lookup call. A mailbox
 * whose folders must be found by display name uses `resolveMailFolders`.
 */
export const DEFAULT_MAIL_FOLDERS: readonly MailFolderSpec[] = [
  { id: 'inbox', kind: 'inbox' },
  { id: 'sentitems', kind: 'sentitems' },
];

const DISPLAY_NAMES: Record<MailFolderKind, string> = {
  inbox: 'Inbox',
  sentitems: 'Sent Items',
};

/** Longest body text kept on the record. Triage reads it; the ledger stores it. */
export const MAX_BODY_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 200;

/** One addressee, reduced to the two fields the ontology and triage use. */
export interface MailAddress {
  name: string | null;
  address: string | null;
}

/**
 * The canonical mail record. A deliberate subset: no HTML body, no
 * attachments, no Graph metadata. Its hash is the third part of the
 * idempotency key, so adding a volatile field here would re-observe every
 * message on the next poll.
 */
export type GraphMailRecord = {
  id: string;
  conversationId: string | null;
  internetMessageId: string | null;
  subject: string | null;
  from: MailAddress | null;
  toRecipients: MailAddress[];
  ccRecipients: MailAddress[];
  receivedDateTime: string | null;
  sentDateTime: string | null;
  // isRead, categories and parentFolderId are deliberately absent: they change
  // when Dom reads a mail or Lance acts on it, and the record's hash is the
  // idempotency key and the executor's target check (spec 7.5). Content only.
  bodyPreview: string | null;
  bodyText: string;
  folder: MailFolderKind;
  removed: boolean;
};

/**
 * The single Haiku call spec 7.1 allows a watcher. Injected rather than
 * built here so the watcher stays testable without a model, and so the
 * caller owns the agent dependencies. `createHaikuLabeller` is the wiring.
 */
export type MailLabeller = (observation: Omit<Observation, 'labels'>) => Promise<string[]>;

/** Applied when the label call fails. Ingestion never stops for a label. */
export const UNLABELLED = 'Unlabelled';

export interface GraphMailWatcherOptions {
  reads: Pick<GraphReads, 'deltaMessages'>;
  label: MailLabeller;
  schedules?: readonly string[];
  folders?: readonly MailFolderSpec[];
  now?: () => string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntity(entity: string): string {
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const code = Number.parseInt(entity.slice(2), 16);
    return Number.isNaN(code) ? '' : String.fromCodePoint(code);
  }
  if (entity.startsWith('#')) {
    const code = Number.parseInt(entity.slice(1), 10);
    return Number.isNaN(code) ? '' : String.fromCodePoint(code);
  }
  return ENTITIES[entity.toLowerCase()] ?? '';
}

/**
 * Tags that sit inside a sentence. Removing them leaves no gap, so
 * "<b>attached</b>." stays "attached." rather than "attached .".
 */
const INLINE_TAGS = /<\/?(?:a|b|i|u|em|strong|span|small|sub|sup|code|font|abbr)\b[^>]*>/gi;

/**
 * A plain-text rendering of an HTML body: scripts, styles and comments
 * dropped whole, inline tags removed, every other tag replaced by a space,
 * the common entities decoded, whitespace collapsed. Not a renderer. It
 * exists so the record carries text a model can read when Graph could not
 * supply text itself.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(INLINE_TAGS, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => decodeEntity(entity))
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** `body.content` when Graph already sent text, otherwise the HTML stripped down. */
export function bodyTextOf(message: Message): string {
  const body = message.body;
  if (body === null || body === undefined) return '';
  const content = body.content ?? '';
  if (content === '') return '';
  const isText = (body.contentType ?? 'text').toLowerCase() === 'text';
  return cap(isText ? content.trim() : htmlToText(content), MAX_BODY_CHARS);
}

function addressOf(recipient: Recipient | null | undefined): MailAddress | null {
  const emailAddress = recipient?.emailAddress;
  if (emailAddress === null || emailAddress === undefined) return null;
  return { name: emailAddress.name ?? null, address: emailAddress.address ?? null };
}

function addressesOf(recipients: Recipient[] | null | undefined): MailAddress[] {
  return (recipients ?? [])
    .map((recipient) => addressOf(recipient))
    .filter((address): address is MailAddress => address !== null);
}

function senderLabel(from: MailAddress | null): string {
  const name = from?.name?.trim();
  if (name !== undefined && name !== '') return name;
  const address = from?.address?.trim();
  if (address !== undefined && address !== '') return address;
  return 'unknown sender';
}

/**
 * Finds the folders behind `Inbox` and `Sent Items` by display name, for a
 * mailbox where the well-known names are not usable. Callers pass the result
 * to `createGraphMailWatcher` as `folders`.
 */
export async function resolveMailFolders(
  reads: Pick<GraphReads, 'listMailFolders'>,
  kinds: readonly MailFolderKind[] = MAIL_FOLDER_KINDS,
): Promise<MailFolderSpec[]> {
  const folders = await reads.listMailFolders();
  return kinds.map((kind) => {
    const wanted = DISPLAY_NAMES[kind].toLowerCase();
    const match = folders.find(
      (folder) => (folder.displayName ?? '').trim().toLowerCase() === wanted,
    );
    if (match === undefined) {
      throw new Error(
        `The mailbox has no folder called "${DISPLAY_NAMES[kind]}", so graph-mail cannot watch ${kind}. Rename the folder in Outlook or pass folders explicitly to createGraphMailWatcher.`,
      );
    }
    return { id: match.id, kind };
  });
}

function parseMessage(raw: unknown, partition: string): Message {
  const parsed = MessageSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(
    `graph-mail could not read a record from folder ${partition}: ${parsed.error.issues
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ')}. Update MessageSchema in packages/connectors/src/graph/types.ts.`,
  );
}

/**
 * The `graph-mail` watcher. Cursors, idempotency and ledger writes belong to
 * the runner; this supplies the folders, the delta poll and the canonical
 * record.
 */
export function createGraphMailWatcher(options: GraphMailWatcherOptions): Watcher {
  const folders = options.folders ?? DEFAULT_MAIL_FOLDERS;
  const kindByPartition = new Map<string, MailFolderKind>(
    folders.map((folder) => [folder.id, folder.kind]),
  );
  const now = options.now ?? nowIso;

  const kindOf = (partition: string): MailFolderKind => {
    const kind = kindByPartition.get(partition);
    if (kind === undefined) {
      throw new Error(
        `graph-mail was asked for partition "${partition}", which is not one of its folders (${folders
          .map((folder) => folder.id)
          .join(', ')}). Remove the stale cursor row or add the folder to createGraphMailWatcher.`,
      );
    }
    return kind;
  };

  return {
    name: GRAPH_MAIL_WATCHER_NAME,
    sourceSystem: 'graph',
    schedules: [...(options.schedules ?? GRAPH_MAIL_SCHEDULES)],

    partitions: () => Promise.resolve(folders.map((folder) => folder.id)),

    async poll(partition: string, cursor: string | null): Promise<PollResult> {
      const kind = kindOf(partition);
      // A first poll (cursor null) walks the whole folder. Graph's message
      // delta endpoint takes no $filter, and `deltaMessages` exposes none, so
      // the backfill cannot be narrowed to the last 14 days here. It is
      // bounded instead by MAX_DELTA_PAGES in the connector and is idempotent,
      // so the cost is one slow first run per folder.
      const delta = await options.reads.deltaMessages({
        folderId: partition,
        ...(cursor === null ? {} : { deltaLink: cursor }),
      });
      const records: SourceRecord[] = delta.messages.map((message) => ({
        id: message.id,
        observedAt: observedAtOf(message, kind) ?? now(),
        raw: message,
      }));
      for (const id of delta.removed) {
        records.push({ id, observedAt: now(), raw: { id }, removed: true });
      }
      return { records, nextCursor: delta.deltaLink };
    },

    async normalise(record: SourceRecord, partition: string): Promise<Observation> {
      const kind = kindOf(partition);
      const message = parseMessage(record.raw, partition);
      const removed = record.removed === true;
      const from = addressOf(message.from ?? message.sender);
      const canonical: GraphMailRecord = {
        id: message.id,
        conversationId: message.conversationId ?? null,
        internetMessageId: message.internetMessageId ?? null,
        subject: message.subject ?? null,
        from,
        toRecipients: addressesOf(message.toRecipients),
        ccRecipients: addressesOf(message.ccRecipients),
        receivedDateTime: message.receivedDateTime ?? null,
        sentDateTime: message.sentDateTime ?? null,
        bodyPreview: message.bodyPreview ?? null,
        bodyText: bodyTextOf(message),
        folder: kind,
        removed,
      };
      const summary = removed
        ? `Message removed from ${kind}`
        : cap(`${senderLabel(from)}: ${message.subject ?? '(no subject)'}`, MAX_SUMMARY_CHARS);
      const observation: Omit<Observation, 'labels'> = {
        sourceSystem: 'graph',
        recordId: message.id,
        observedAt: record.observedAt,
        record: canonical,
        correlationKey: message.conversationId ?? message.id,
        summary,
        ...(message.webLink === null || message.webLink === undefined
          ? {}
          : { url: message.webLink }),
      };
      // A tombstone carries no sender, subject or body, so there is nothing
      // to label and no reason to spend a model call on it.
      if (removed) return observation;
      return { ...observation, labels: await labelSafely(options.label, observation) };
    },
  };
}

function observedAtOf(message: Message, kind: MailFolderKind): string | null {
  const preferred = kind === 'sentitems' ? message.sentDateTime : message.receivedDateTime;
  return preferred ?? message.receivedDateTime ?? message.sentDateTime ?? null;
}

/**
 * Spec 7.1 makes watchers deterministic and allows one Haiku label call. A
 * failed label must not stop ingestion, so a failure is recorded as
 * `Unlabelled` and the observation is written anyway.
 */
async function labelSafely(
  label: MailLabeller,
  observation: Omit<Observation, 'labels'>,
): Promise<string[]> {
  try {
    const labels = await label(observation);
    return labels.length === 0 ? [UNLABELLED] : labels;
  } catch {
    return [UNLABELLED];
  }
}
