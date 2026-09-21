import { z } from 'zod';

/**
 * Zod schemas for the slice of the Notion API Lance reads, plus the
 * normalisation from a Notion page to a plain `TaskRecord`.
 *
 * Only the eleven properties ADR 0009 lets Lance write are modelled. Every
 * other property on the All Tasks DB (Hubspot Task ID, rollups, formulas,
 * Completed on, Delegate to Ian and the rest) is read-only to Lance and is
 * deliberately absent here, so nothing downstream can round-trip it into a
 * write.
 */

/** Notion property names, in the spelling the All Tasks DB uses. */
export const TASK_PROPERTY_NAMES = {
  title: 'Title',
  status: 'Status',
  assigneeIds: 'Assignee',
  contributorIds: 'Contributors',
  due: 'Due',
  priority: 'Priority',
  projectIds: 'Project',
  typeIds: 'Type',
  subTypes: 'Sub-type',
  description: 'Description',
  notes: 'Notes',
} as const satisfies Record<string, string>;

/** The input keys of `createTask` and `updateTask`. */
export type TaskInputKey = keyof typeof TASK_PROPERTY_NAMES;

export const TASK_STATUSES = [
  'Not Started',
  'In Progress',
  'On hold',
  'Done',
  'Cancelled',
  'Archived',
] as const;

export const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Critical Milestone'] as const;

export const TASK_SUB_TYPES = ['External', 'Internal', 'Deliverables', 'Client Task'] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export const taskSubTypeSchema = z.enum(TASK_SUB_TYPES);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskSubType = z.infer<typeof taskSubTypeSchema>;

/** Notion accepts ids with or without the UUID dashes and returns them dashed. */
export const notionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i,
    'must be a Notion id: 32 hexadecimal characters, dashes optional',
  );

/** Notion rejects a rich text value longer than this (API request limits). */
export const RICH_TEXT_MAX_LENGTH = 2000;
/** Notion rejects a relation, people or multi-select list longer than this. */
export const LIST_MAX_LENGTH = 100;

const richTextItemSchema = z.object({ plain_text: z.string() });

const namedOptionSchema = z.object({ name: z.string() });

const titleValueSchema = z.object({
  type: z.literal('title'),
  title: z.array(richTextItemSchema),
});

const richTextValueSchema = z.object({
  type: z.literal('rich_text'),
  rich_text: z.array(richTextItemSchema),
});

const statusValueSchema = z.object({
  type: z.literal('status'),
  status: namedOptionSchema.nullable(),
});

const selectValueSchema = z.object({
  type: z.literal('select'),
  select: namedOptionSchema.nullable(),
});

const multiSelectValueSchema = z.object({
  type: z.literal('multi_select'),
  multi_select: z.array(namedOptionSchema),
});

const dateValueSchema = z.object({
  type: z.literal('date'),
  date: z
    .object({
      start: z.string(),
      end: z.string().nullable().optional(),
      time_zone: z.string().nullable().optional(),
    })
    .nullable(),
});

const idRefSchema = z.object({ id: z.string() });

const peopleValueSchema = z.object({
  type: z.literal('people'),
  people: z.array(idRefSchema),
});

const relationValueSchema = z.object({
  type: z.literal('relation'),
  relation: z.array(idRefSchema),
});

/**
 * Each property is optional: a renamed or removed column must surface as a
 * `getDataSourceSchema` mismatch in the watcher, not as a parse failure that
 * stops a whole ingestion run on one page.
 */
const taskPropertiesSchema = z.object({
  Title: titleValueSchema.optional(),
  Status: statusValueSchema.optional(),
  Assignee: peopleValueSchema.optional(),
  Contributors: peopleValueSchema.optional(),
  Due: dateValueSchema.optional(),
  Priority: selectValueSchema.optional(),
  Project: relationValueSchema.optional(),
  Type: relationValueSchema.optional(),
  'Sub-type': multiSelectValueSchema.optional(),
  Description: richTextValueSchema.optional(),
  Notes: richTextValueSchema.optional(),
});

/**
 * `archived` was renamed `in_trash` in Notion version 2025-09-03 and dropped
 * in 2026-03-11. Both are accepted so a recorded fixture from either version
 * parses; neither is required.
 */
export const notionPageSchema = z.object({
  object: z.literal('page'),
  id: z.string(),
  url: z.string(),
  created_time: z.string(),
  last_edited_time: z.string(),
  in_trash: z.boolean().optional(),
  archived: z.boolean().optional(),
  properties: taskPropertiesSchema,
});

export type NotionPage = z.infer<typeof notionPageSchema>;

export const notionQueryResponseSchema = z.object({
  object: z.literal('list'),
  results: z.array(notionPageSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export type NotionQueryResponse = z.infer<typeof notionQueryResponseSchema>;

export const notionDataSourceSchema = z.object({
  object: z.literal('data_source'),
  id: z.string(),
  title: z.array(richTextItemSchema),
  properties: z.record(
    z.string(),
    z.object({ id: z.string(), name: z.string(), type: z.string() }),
  ),
});

export type NotionDataSource = z.infer<typeof notionDataSourceSchema>;

export const notionUserSchema = z.object({
  object: z.literal('user'),
  id: z.string(),
  type: z.enum(['person', 'bot']).optional(),
  name: z.string().nullable().optional(),
  person: z.object({ email: z.string().optional() }).optional(),
});

export type NotionUser = z.infer<typeof notionUserSchema>;

export const notionUserListSchema = z.object({
  object: z.literal('list'),
  results: z.array(notionUserSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/** What a page create or update returns, narrowed to what a write reports back. */
export const notionPageRefSchema = z.object({
  id: z.string(),
  url: z.string(),
});

export const notionCommentSchema = z.object({
  object: z.literal('comment'),
  id: z.string(),
  discussion_id: z.string().optional(),
});

/** One All Tasks row, flattened to plain values for the ontology and the UI. */
export interface TaskRecord {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  /** A `TaskStatus`, or whatever Notion returns should the options change. */
  readonly status: string | null;
  readonly assigneeIds: readonly string[];
  readonly contributorIds: readonly string[];
  /** Date only, YYYY-MM-DD, as stored. Displayed DD/MM/YYYY by Notion. */
  readonly due: string | null;
  /** A `TaskPriority`, or whatever Notion returns should the options change. */
  readonly priority: string | null;
  readonly projectIds: readonly string[];
  readonly typeIds: readonly string[];
  readonly subTypes: readonly string[];
  readonly description: string;
  readonly notes: string;
  readonly lastEditedTime: string;
}

/** One column of the data source, for the permitted-property drift check. */
export interface DataSourceProperty {
  readonly name: string;
  readonly type: string;
}

export interface DataSourceSchema {
  readonly id: string;
  readonly title: string;
  readonly properties: readonly DataSourceProperty[];
}

/** A Notion workspace member, for resolving a delegate's name to a user id. */
export interface NotionUserSummary {
  readonly id: string;
  readonly name: string | null;
  readonly email?: string;
}

function plainText(items: readonly { plain_text: string }[] | undefined): string {
  return items === undefined ? '' : items.map((item) => item.plain_text).join('');
}

function ids(refs: readonly { id: string }[] | undefined): readonly string[] {
  return refs === undefined ? [] : refs.map((ref) => ref.id);
}

/** Normalises a Notion page into a `TaskRecord`. Empty properties map to `null`, `[]` or `''`. */
export function fromNotionPage(page: NotionPage): TaskRecord {
  const properties = page.properties;
  return {
    id: page.id,
    url: page.url,
    title: plainText(properties.Title?.title),
    status: properties.Status?.status?.name ?? null,
    assigneeIds: ids(properties.Assignee?.people),
    contributorIds: ids(properties.Contributors?.people),
    due: properties.Due?.date?.start ?? null,
    priority: properties.Priority?.select?.name ?? null,
    projectIds: ids(properties.Project?.relation),
    typeIds: ids(properties.Type?.relation),
    subTypes: properties['Sub-type']?.multi_select.map((option) => option.name) ?? [],
    description: plainText(properties.Description?.rich_text),
    notes: plainText(properties.Notes?.rich_text),
    lastEditedTime: page.last_edited_time,
  };
}

/** Normalises a Notion user, keeping `email` only when the workspace exposes it. */
export function fromNotionUser(user: NotionUser): NotionUserSummary {
  const email = user.person?.email;
  return {
    id: user.id,
    name: user.name ?? null,
    ...(email === undefined ? {} : { email }),
  };
}

/** Normalises a data source into the property list the watcher compares against config. */
export function fromNotionDataSource(dataSource: NotionDataSource): DataSourceSchema {
  return {
    id: dataSource.id,
    title: plainText(dataSource.title),
    properties: Object.values(dataSource.properties)
      .map((property) => ({ name: property.name, type: property.type }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
