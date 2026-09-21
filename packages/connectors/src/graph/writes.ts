import { z } from 'zod';
import { graphWriteAccess, GRAPH_BASE_URL, type GraphConnector } from './client.js';

/**
 * The five Graph writes of spec 8: create draft, create reply draft,
 * apply categories, move message, create event (hold). There is no send,
 * no delete and no reply-all send, and there never will be in v1: sending
 * mail and deleting are hard floors at `forbid` (non-negotiable 3), and
 * `Mail.Send` is not among the consented scopes (spec 4.1), so a call
 * added here would fail at Entra as well as at the policy engine.
 *
 * Each function takes the connector as its first argument so the module
 * stays free of construction and the executor supplies a connector built
 * with the current access token. Only `apps/worker/src/executor` may
 * import this module's re-export, enforced by the ESLint boundary on
 * `@lance/connectors/writes`, and the write capability itself comes from
 * `graphWriteAccess`, which no barrel exports.
 *
 * A POST creates a record, so it is not marked idempotent: it retries only
 * on 429, where Graph states it refused the request. The PATCHes name the
 * record they change, so repeating one cannot make a second, and they keep
 * the full retry policy.
 */

export interface GraphWriteResult {
  id: string;
  /** Graph returns a `webLink` for messages and events; undefined otherwise. */
  webLink: string | undefined;
}

const WrittenRecordSchema = z.looseObject({
  id: z.string(),
  webLink: z.string().nullish(),
});

function toResult(record: z.infer<typeof WrittenRecordSchema>): GraphWriteResult {
  return { id: record.id, webLink: record.webLink ?? undefined };
}

/** `{ emailAddress: { address } }`, the only recipient shape Graph accepts. */
function recipients(addresses: readonly string[]): { emailAddress: { address: string } }[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

function textBody(content: string): { contentType: 'text'; content: string } {
  return { contentType: 'text', content };
}

export interface CreateDraftInput {
  subject: string;
  bodyText: string;
  to: readonly string[];
  cc?: readonly string[];
}

export interface CreateReplyDraftInput {
  messageId: string;
  comment: string;
}

export interface ApplyCategoriesInput {
  messageId: string;
  /** The complete category list for the message; Graph replaces, not merges. */
  categories: readonly string[];
}

export interface MoveMessageInput {
  messageId: string;
  destinationFolderId: string;
}

export interface CreateEventInput {
  subject: string;
  /** Local date and time, `YYYY-MM-DDTHH:mm:ss`, read in `timeZone`. */
  start: string;
  end: string;
  /** IANA or Windows zone name Graph resolves `start` and `end` against. */
  timeZone: string;
  /** A hold is not an appointment: it never reminds. */
  isReminderOn?: false;
  /** A hold blocks the slot. */
  showAs?: 'busy';
}

const messageUrl = (messageId: string): string =>
  `${GRAPH_BASE_URL}/me/messages/${encodeURIComponent(messageId)}`;

async function createDraft(
  graph: GraphConnector,
  input: CreateDraftInput,
): Promise<GraphWriteResult> {
  const body: Record<string, unknown> = {
    subject: input.subject,
    body: textBody(input.bodyText),
    toRecipients: recipients(input.to),
  };
  if (input.cc !== undefined && input.cc.length > 0) {
    body['ccRecipients'] = recipients(input.cc);
  }
  const record = await graphWriteAccess(graph)(
    'createDraft',
    `${GRAPH_BASE_URL}/me/messages`,
    WrittenRecordSchema,
    { method: 'POST', body },
  );
  return toResult(record);
}

/**
 * Two calls, as Graph requires: `createReply` makes the draft, with the
 * recipients and conversation already set, and the PATCH puts Lance's
 * text in it.
 */
async function createReplyDraft(
  graph: GraphConnector,
  input: CreateReplyDraftInput,
): Promise<GraphWriteResult> {
  const write = graphWriteAccess(graph);
  const draft = await write(
    'createReplyDraft',
    `${messageUrl(input.messageId)}/createReply`,
    WrittenRecordSchema,
    { method: 'POST', body: {} },
  );
  const updated = await write(
    'createReplyDraft',
    messageUrl(draft.id),
    WrittenRecordSchema,
    { method: 'PATCH', body: { body: textBody(input.comment) } },
    { idempotent: true },
  );
  return toResult(updated);
}

async function applyCategories(
  graph: GraphConnector,
  input: ApplyCategoriesInput,
): Promise<GraphWriteResult> {
  const record = await graphWriteAccess(graph)(
    'applyCategories',
    messageUrl(input.messageId),
    WrittenRecordSchema,
    { method: 'PATCH', body: { categories: [...input.categories] } },
    { idempotent: true },
  );
  return toResult(record);
}

/** Graph answers with the message under its new id in the destination folder. */
async function moveMessage(
  graph: GraphConnector,
  input: MoveMessageInput,
): Promise<GraphWriteResult> {
  const record = await graphWriteAccess(graph)(
    'moveMessage',
    `${messageUrl(input.messageId)}/move`,
    WrittenRecordSchema,
    { method: 'POST', body: { destinationId: input.destinationFolderId } },
  );
  return toResult(record);
}

async function createEvent(
  graph: GraphConnector,
  input: CreateEventInput,
): Promise<GraphWriteResult> {
  const record = await graphWriteAccess(graph)(
    'createEvent',
    `${GRAPH_BASE_URL}/me/events`,
    WrittenRecordSchema,
    {
      method: 'POST',
      body: {
        subject: input.subject,
        start: { dateTime: input.start, timeZone: input.timeZone },
        end: { dateTime: input.end, timeZone: input.timeZone },
        isReminderOn: input.isReminderOn ?? false,
        showAs: input.showAs ?? 'busy',
      },
    },
  );
  return toResult(record);
}

/** The complete set of Graph writes. Five, and a test holds it to five. */
export const graphWrites = {
  createDraft,
  createReplyDraft,
  applyCategories,
  moveMessage,
  createEvent,
} as const;

export type GraphWrites = typeof graphWrites;
