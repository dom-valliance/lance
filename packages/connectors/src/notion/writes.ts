import { z } from 'zod';
import type { CallContext } from '../core/connector.js';
import { ConnectorError } from '../core/errors.js';
import { notionPageUrl, notionSendAccess, type NotionConnector } from './client.js';
import {
  LIST_MAX_LENGTH,
  notionCommentSchema,
  notionIdSchema,
  notionPageRefSchema,
  RICH_TEXT_MAX_LENGTH,
  TASK_PROPERTY_NAMES,
  taskPrioritySchema,
  taskStatusSchema,
  taskSubTypeSchema,
} from './types.js';

/**
 * The three writes ADR 0009 allows on the All Tasks DB. There is no archive,
 * no delete and no schema change: Lance never removes a row and never touches
 * the database's columns. The request function comes from `notionSendAccess`,
 * which no barrel exports, so the connector object callers hold cannot write.
 *
 * `updateTask` names the page it changes, so a repeat cannot make a second
 * record and it keeps the full retry policy. `createTask` and `addComment`
 * create one, so they retry only on 429, where Notion states it refused the
 * request.
 */

export const createTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1, 'a task needs a title').max(RICH_TEXT_MAX_LENGTH),
  status: taskStatusSchema.optional(),
  /** Defaults to Dom's Notion user id, supplied by the caller from config. */
  assigneeIds: z.array(notionIdSchema).max(LIST_MAX_LENGTH).optional(),
  contributorIds: z.array(notionIdSchema).max(LIST_MAX_LENGTH).optional(),
  /** Date only, YYYY-MM-DD. Notion displays it DD/MM/YYYY. */
  due: z.iso.date().optional(),
  priority: taskPrioritySchema.optional(),
  projectIds: z.array(notionIdSchema).max(LIST_MAX_LENGTH).optional(),
  typeIds: z.array(notionIdSchema).max(LIST_MAX_LENGTH).optional(),
  subTypes: z.array(taskSubTypeSchema).max(LIST_MAX_LENGTH).optional(),
  description: z.string().max(RICH_TEXT_MAX_LENGTH).optional(),
  notes: z.string().max(RICH_TEXT_MAX_LENGTH).optional(),
});

export const updateTaskPatchSchema = createTaskInputSchema.partial();

export const commentTextSchema = z
  .string()
  .trim()
  .min(1, 'a comment needs text')
  .max(RICH_TEXT_MAX_LENGTH);

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskPatch = z.infer<typeof updateTaskPatchSchema>;

export interface WriteResult {
  readonly id: string;
  readonly url: string;
}

export interface CreateTaskArgs {
  dataSourceId: string;
  /** `notion.permittedTaskProperties` from config (ADR 0009). */
  permittedProperties: readonly string[];
  input: unknown;
}

export interface UpdateTaskArgs {
  pageId: string;
  permittedProperties: readonly string[];
  patch: unknown;
}

export interface AddCommentArgs {
  pageId: string;
  text: string;
}

const PROPERTY_NAME_BY_KEY: Record<string, string> = TASK_PROPERTY_NAMES;

function rejection(operation: string, message: string): ConnectorError {
  return new ConnectorError(`notion ${operation}: ${message}`, {
    connector: 'notion',
    operation,
    retryable: false,
  });
}

/**
 * Rejects any key outside the permitted list before a request is built, so a
 * write naming a read-only property never reaches Notion. Unknown keys are
 * reported under the name the caller used.
 */
function assertPermittedKeys(
  operation: string,
  value: unknown,
  permittedProperties: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw rejection(operation, 'expected an object of task properties.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const propertyName = PROPERTY_NAME_BY_KEY[key] ?? key;
    if (!permittedProperties.includes(propertyName)) {
      throw rejection(
        operation,
        `"${propertyName}" is read-only to Lance. ADR 0009 permits only ${permittedProperties.join(', ')}. ` +
          'Remove it and propose the change to Dom instead.',
      );
    }
  }
  return record;
}

function richText(text: string): readonly { text: { content: string } }[] {
  return text.length === 0 ? [] : [{ text: { content: text } }];
}

function idRefs(ids: readonly string[]): readonly { id: string }[] {
  return ids.map((id) => ({ id }));
}

/** Builds the Notion `properties` object for exactly the keys the patch sets. */
function buildProperties(patch: UpdateTaskPatch): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    properties[TASK_PROPERTY_NAMES.title] = { title: richText(patch.title) };
  }
  if (patch.status !== undefined) {
    properties[TASK_PROPERTY_NAMES.status] = { status: { name: patch.status } };
  }
  if (patch.assigneeIds !== undefined) {
    properties[TASK_PROPERTY_NAMES.assigneeIds] = { people: idRefs(patch.assigneeIds) };
  }
  if (patch.contributorIds !== undefined) {
    properties[TASK_PROPERTY_NAMES.contributorIds] = { people: idRefs(patch.contributorIds) };
  }
  if (patch.due !== undefined) {
    properties[TASK_PROPERTY_NAMES.due] = { date: { start: patch.due } };
  }
  if (patch.priority !== undefined) {
    properties[TASK_PROPERTY_NAMES.priority] = { select: { name: patch.priority } };
  }
  if (patch.projectIds !== undefined) {
    properties[TASK_PROPERTY_NAMES.projectIds] = { relation: idRefs(patch.projectIds) };
  }
  if (patch.typeIds !== undefined) {
    properties[TASK_PROPERTY_NAMES.typeIds] = { relation: idRefs(patch.typeIds) };
  }
  if (patch.subTypes !== undefined) {
    properties[TASK_PROPERTY_NAMES.subTypes] = {
      multi_select: patch.subTypes.map((name) => ({ name })),
    };
  }
  if (patch.description !== undefined) {
    properties[TASK_PROPERTY_NAMES.description] = { rich_text: richText(patch.description) };
  }
  if (patch.notes !== undefined) {
    properties[TASK_PROPERTY_NAMES.notes] = { rich_text: richText(patch.notes) };
  }
  return properties;
}

/** Creates one page in the All Tasks data source. */
async function createTask(
  notion: NotionConnector,
  args: CreateTaskArgs,
  context: CallContext = {},
): Promise<WriteResult> {
  assertPermittedKeys('createTask', args.input, args.permittedProperties);
  const input = createTaskInputSchema.parse(args.input);
  const body = {
    parent: { type: 'data_source_id', data_source_id: args.dataSourceId },
    properties: buildProperties(input),
  };
  const send = notionSendAccess(notion);
  const raw = await notion.connector.write('createTask', { ...context, request: body }, () =>
    send('createTask', '/pages', { method: 'POST', body }),
  );
  return notionPageRefSchema.parse(raw);
}

/** Updates only the permitted properties the patch names on one existing page. */
async function updateTask(
  notion: NotionConnector,
  args: UpdateTaskArgs,
  context: CallContext = {},
): Promise<WriteResult> {
  const record = assertPermittedKeys('updateTask', args.patch, args.permittedProperties);
  if (Object.keys(record).length === 0) {
    throw rejection('updateTask', 'the patch is empty; name at least one property to change.');
  }
  const patch = updateTaskPatchSchema.parse(record);
  const body = { properties: buildProperties(patch) };
  const send = notionSendAccess(notion);
  const raw = await notion.connector.write(
    'updateTask',
    { ...context, request: { pageId: args.pageId, ...body } },
    () => send('updateTask', `/pages/${args.pageId}`, { method: 'PATCH', body }),
    { idempotent: true },
  );
  return notionPageRefSchema.parse(raw);
}

/**
 * Adds one comment to a task page. Notion's comment response carries no URL,
 * so the result points at the page the comment landed on.
 */
async function addComment(
  notion: NotionConnector,
  args: AddCommentArgs,
  context: CallContext = {},
): Promise<WriteResult> {
  const text = commentTextSchema.parse(args.text);
  const body = { parent: { page_id: args.pageId }, rich_text: richText(text) };
  const send = notionSendAccess(notion);
  const raw = await notion.connector.write('addComment', { ...context, request: body }, () =>
    send('addComment', '/comments', { method: 'POST', body }),
  );
  const comment = notionCommentSchema.parse(raw);
  return { id: comment.id, url: notionPageUrl(args.pageId) };
}

/** The complete set of Notion writes. Nothing archives, deletes or alters the schema. */
export const notionWrites = { createTask, updateTask, addComment } as const;
