import { z } from 'zod';

/**
 * Zod schemas for the slice of the Notion API Lance reads, plus the
 * normalisation from a Notion page to a plain `TaskRecord` or `MeetingRecord`.
 *
 * On All Tasks, only the eleven properties ADR 0009 lets Lance write are
 * modelled. Every
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

/**
 * The Meetings DB property names, in the spelling that database uses. Lance
 * reads them and never writes them: there is no Meetings write function, the
 * database is absent from the permitted-property list, and so the guard in
 * `writes.ts` refuses every name here. `Type` is the one name both databases
 * use; on All Tasks it is the permitted Type relation, and a write always
 * names the All Tasks data source, so the two never meet.
 *
 * `Created time`, `Last edited time` and `Last edited by` are absent: the
 * first two arrive on the page envelope and the third is never read.
 */
export const MEETING_PROPERTY_NAMES = {
  name: 'Name',
  attendeeIds: 'Attendees',
  ownerIds: 'Owner',
  type: 'Type',
  eventTime: 'Event time',
  date: 'Date',
  summary: 'Summary',
  aiSummary: 'AI summary',
  attendeeNames: 'Attendees 1',
  projectIds: 'Projects',
  accountIds: 'Accounts (Clients)',
  threadTags: 'Thread Tag',
  threadSessionIds: 'Thread Session',
} as const satisfies Record<string, string>;

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
const pageEnvelopeSchema = z.object({
  object: z.literal('page'),
  id: z.string(),
  url: z.string(),
  created_time: z.string(),
  last_edited_time: z.string(),
  in_trash: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const notionPageSchema = pageEnvelopeSchema.extend({
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

/**
 * The Meetings DB columns Lance reads. Every one is optional for the same
 * reason the task columns are: a renamed column must not stop an ingestion
 * run on one page. `Type` here is a select, not the relation of the same
 * name on All Tasks.
 */
const meetingPropertiesSchema = z.object({
  Name: titleValueSchema.optional(),
  Attendees: peopleValueSchema.optional(),
  Owner: peopleValueSchema.optional(),
  Type: selectValueSchema.optional(),
  'Event time': dateValueSchema.optional(),
  Date: dateValueSchema.optional(),
  Summary: richTextValueSchema.optional(),
  'AI summary': richTextValueSchema.optional(),
  'Attendees 1': richTextValueSchema.optional(),
  Projects: relationValueSchema.optional(),
  'Accounts (Clients)': relationValueSchema.optional(),
  'Thread Tag': multiSelectValueSchema.optional(),
  'Thread Session': relationValueSchema.optional(),
});

export const notionMeetingPageSchema = pageEnvelopeSchema.extend({
  properties: meetingPropertiesSchema,
});

export type NotionMeetingPage = z.infer<typeof notionMeetingPageSchema>;

export const notionMeetingQueryResponseSchema = z.object({
  object: z.literal('list'),
  results: z.array(notionMeetingPageSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/** One Meetings row, flattened the way `TaskRecord` flattens an All Tasks row. */
export interface MeetingRecord {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly attendeeIds: readonly string[];
  readonly ownerIds: readonly string[];
  /** A Meetings Type option: Client Meeting, Partner Meeting, Standup and the rest. */
  readonly type: string | null;
  /** The start of Event time. Notion stores a range, so the end may differ. */
  readonly eventTimeStart: string | null;
  readonly eventTimeEnd: string | null;
  readonly date: string | null;
  /** The post-meeting summary Dom writes. */
  readonly summary: string;
  readonly aiSummary: string;
  /** Free text attendees, for people who are not Notion users. */
  readonly attendeeNames: string;
  readonly projectIds: readonly string[];
  readonly accountIds: readonly string[];
  readonly threadTags: readonly string[];
  readonly threadSessionIds: readonly string[];
  readonly createdTime: string;
  readonly lastEditedTime: string;
}

/**
 * The block types `getPageText` renders. Every other type, Notion's Meeting
 * Notes AI blocks included, is skipped rather than treated as an error.
 */
export const TEXT_BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'quote',
] as const;

const TEXT_BLOCK_TYPE_NAMES = new Set<string>(TEXT_BLOCK_TYPES);

const textBlockPayloadSchema = z.object({ rich_text: z.array(richTextItemSchema) });

/**
 * A block, kept loose on purpose: the payload's shape differs per type and
 * an unfamiliar type must parse and then be skipped, never fail.
 */
export const notionBlockSchema = z.looseObject({
  object: z.literal('block'),
  id: z.string(),
  type: z.string(),
});

export type NotionBlock = z.infer<typeof notionBlockSchema>;

export const notionBlockListSchema = z.object({
  object: z.literal('list'),
  results: z.array(notionBlockSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/**
 * The plain text of one block, or `null` when the block carries none Lance
 * can read: an unsupported type, a payload without rich text, or a block
 * whose text is blank.
 */
export function blockPlainText(block: NotionBlock): string | null {
  if (!TEXT_BLOCK_TYPE_NAMES.has(block.type)) return null;
  const payload = textBlockPayloadSchema.safeParse(block[block.type]);
  if (!payload.success) return null;
  const text = plainText(payload.data.rich_text).trim();
  return text === '' ? null : text;
}

/** Normalises a Notion page into a `MeetingRecord`. Lance never writes these properties. */
export function fromNotionMeetingPage(page: NotionMeetingPage): MeetingRecord {
  const properties = page.properties;
  const eventTime = properties['Event time']?.date ?? null;
  return {
    id: page.id,
    url: page.url,
    name: plainText(properties.Name?.title),
    attendeeIds: ids(properties.Attendees?.people),
    ownerIds: ids(properties.Owner?.people),
    type: properties.Type?.select?.name ?? null,
    eventTimeStart: eventTime?.start ?? null,
    eventTimeEnd: eventTime?.end ?? null,
    date: properties.Date?.date?.start ?? null,
    summary: plainText(properties.Summary?.rich_text),
    aiSummary: plainText(properties['AI summary']?.rich_text),
    attendeeNames: plainText(properties['Attendees 1']?.rich_text),
    projectIds: ids(properties.Projects?.relation),
    accountIds: ids(properties['Accounts (Clients)']?.relation),
    threadTags: properties['Thread Tag']?.multi_select.map((option) => option.name) ?? [],
    threadSessionIds: ids(properties['Thread Session']?.relation),
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
  };
}
