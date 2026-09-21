import { z } from 'zod';

/**
 * Zod schemas for the subsets of Microsoft Graph that Lance reads (spec 8,
 * `graph` row). Graph adds fields between versions and returns fields the
 * `$select` did not ask for, so every resource schema is loose: unknown
 * keys pass through rather than failing the parse. The two exceptions are
 * mailbox settings, where spec 4.1 limits us to the time zone and working
 * hours, and the delta envelope, which has a fixed shape.
 */

export const EmailAddressSchema = z.looseObject({
  name: z.string().nullish(),
  address: z.string().nullish(),
});
export type EmailAddress = z.infer<typeof EmailAddressSchema>;

export const RecipientSchema = z.looseObject({
  emailAddress: EmailAddressSchema.nullish(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

export const ItemBodySchema = z.looseObject({
  contentType: z.string().nullish(),
  content: z.string().nullish(),
});
export type ItemBody = z.infer<typeof ItemBodySchema>;

export const MailFolderSchema = z.looseObject({
  id: z.string(),
  displayName: z.string().nullish(),
  parentFolderId: z.string().nullish(),
  childFolderCount: z.number().nullish(),
  totalItemCount: z.number().nullish(),
  unreadItemCount: z.number().nullish(),
});
export type MailFolder = z.infer<typeof MailFolderSchema>;

export const OutlookCategorySchema = z.looseObject({
  id: z.string(),
  displayName: z.string().nullish(),
  color: z.string().nullish(),
});
export type OutlookCategory = z.infer<typeof OutlookCategorySchema>;

/**
 * Only the two fields spec 4.1 asks for. A stripping object, not a loose
 * one: nothing else from `/me/mailboxSettings` may reach the rest of Lance.
 */
export const MailboxSettingsSchema = z.object({
  timeZone: z.string().nullish(),
  workingHours: z
    .looseObject({
      daysOfWeek: z.array(z.string()).nullish(),
      startTime: z.string().nullish(),
      endTime: z.string().nullish(),
      timeZone: z.looseObject({ name: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
export type MailboxSettings = z.infer<typeof MailboxSettingsSchema>;

export const MessageSchema = z.looseObject({
  id: z.string(),
  conversationId: z.string().nullish(),
  subject: z.string().nullish(),
  from: RecipientSchema.nullish(),
  sender: RecipientSchema.nullish(),
  toRecipients: z.array(RecipientSchema).nullish(),
  ccRecipients: z.array(RecipientSchema).nullish(),
  receivedDateTime: z.string().nullish(),
  sentDateTime: z.string().nullish(),
  isRead: z.boolean().nullish(),
  isDraft: z.boolean().nullish(),
  categories: z.array(z.string()).nullish(),
  parentFolderId: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  body: ItemBodySchema.nullish(),
  internetMessageId: z.string().nullish(),
  webLink: z.string().nullish(),
});
export type Message = z.infer<typeof MessageSchema>;

export const DateTimeTimeZoneSchema = z.looseObject({
  dateTime: z.string(),
  timeZone: z.string().nullish(),
});
export type DateTimeTimeZone = z.infer<typeof DateTimeTimeZoneSchema>;

export const AttendeeSchema = z.looseObject({
  type: z.string().nullish(),
  status: z.looseObject({ response: z.string().nullish(), time: z.string().nullish() }).nullish(),
  emailAddress: EmailAddressSchema.nullish(),
});
export type Attendee = z.infer<typeof AttendeeSchema>;

export const LocationSchema = z.looseObject({
  displayName: z.string().nullish(),
  locationType: z.string().nullish(),
});
export type Location = z.infer<typeof LocationSchema>;

export const OnlineMeetingSchema = z.looseObject({
  joinUrl: z.string().nullish(),
});
export type OnlineMeeting = z.infer<typeof OnlineMeetingSchema>;

export const CalendarEventSchema = z.looseObject({
  id: z.string(),
  subject: z.string().nullish(),
  start: DateTimeTimeZoneSchema.nullish(),
  end: DateTimeTimeZoneSchema.nullish(),
  isCancelled: z.boolean().nullish(),
  isAllDay: z.boolean().nullish(),
  organizer: RecipientSchema.nullish(),
  attendees: z.array(AttendeeSchema).nullish(),
  location: LocationSchema.nullish(),
  onlineMeeting: OnlineMeetingSchema.nullish(),
  webLink: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  iCalUId: z.string().nullish(),
  seriesMasterId: z.string().nullish(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

/** A collection response: `GET /me/mailFolders` and friends. */
export const CollectionSchema = z.looseObject({
  value: z.array(z.unknown()),
  '@odata.nextLink': z.string().optional(),
});

/**
 * One page of a delta query. Graph sends `@odata.nextLink` on every page
 * but the last, and `@odata.deltaLink` on the last one only.
 */
export const DeltaPageSchema = z.looseObject({
  value: z.array(z.unknown()),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});

/**
 * A tombstone in a delta page. Graph marks a deleted or moved-out record
 * with `@removed` and sends nothing else but its id.
 */
export const RemovedEntrySchema = z.looseObject({
  id: z.string(),
  '@removed': z.looseObject({ reason: z.string().nullish() }),
});

/** True when a delta entry is a tombstone rather than a record. */
export function isRemovedEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && '@removed' in entry;
}

export interface MessageDelta {
  messages: Message[];
  /** Ids of messages Graph reports as deleted or moved out of the folder. */
  removed: string[];
  /** The token to pass back as `deltaLink` on the next poll. */
  deltaLink: string;
}

export interface CalendarEventDelta {
  events: CalendarEvent[];
  removed: string[];
  deltaLink: string;
}
