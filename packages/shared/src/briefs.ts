import { z } from 'zod';
import {
  ActionClassSchema,
  AlertSeveritySchema,
  CommitmentDirectionSchema,
  CounterpartyClassSchema,
} from './enums.js';
import { ProvenanceRefSchema, UlidSchema } from './schemas.js';

/**
 * The structured `briefs.content` of the two briefs the Today page renders:
 * the morning brief (spec 10.1) and the afternoon board (spec 10.2). The
 * planner writes these shapes, the api parses them before they leave the
 * boundary, and the web app reads the inferred types.
 */

/** ISO-8601 timestamp with an explicit offset, as every stored timestamp is. */
const TimestampSchema = z.string().datetime({ offset: true });

/** A calendar day in `YYYY-MM-DD`, the brief's own date in Europe/London. */
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a "YYYY-MM-DD" date');

/** External or internal, which decides how early the prep expands. */
const AudienceSchema = z.enum(['external', 'internal']);

const MeetingMarkerSchema = z.object({
  start: TimestampSchema,
  title: z.string(),
});

/** Spec 10.1 item 1: first and last meeting, meeting hours, longest free block. */
const DayShapeSchema = z.object({
  firstMeeting: MeetingMarkerSchema.nullable(),
  lastMeeting: MeetingMarkerSchema.nullable(),
  meetingHours: z.number().nonnegative(),
  workingHours: z.number().positive(),
  longestFreeBlock: z
    .object({ start: TimestampSchema, end: TimestampSchema, hours: z.number() })
    .nullable(),
  proposedHolds: z.array(z.object({ proposalId: UlidSchema, title: z.string() })),
  /** Why no hold was proposed, when none was. */
  note: z.string().nullable(),
  calendarObservedAt: TimestampSchema,
});

/** One of the last three interactions with an attendee (spec 10.1 item 2). */
const InteractionSchema = z.object({
  kind: z.enum(['mail', 'transcript', 'meeting']),
  at: TimestampSchema,
  summary: z.string(),
  provenance: ProvenanceRefSchema,
});

const AttendeeSchema = z.object({
  personId: z.string().nullable(),
  name: z.string(),
  role: z.string().nullable(),
  organisation: z.string().nullable(),
  email: z.string().nullable(),
  /** True for an attendee the ontology could not resolve; the page flags them. */
  unknown: z.boolean(),
  interactions: z.array(InteractionSchema),
});

const MeetingCommitmentSchema = z.object({
  commitmentId: UlidSchema,
  direction: CommitmentDirectionSchema,
  description: z.string(),
  dueAt: TimestampSchema.nullable(),
  overdueDays: z.number().int().nullable(),
});

const MeetingDocumentSchema = z.object({
  title: z.string(),
  source: z.string(),
  editedAt: TimestampSchema.nullable(),
  url: z.string().url().nullable(),
});

const MeetingSchema = z.object({
  /** The Graph event id, which is also the provenance record id. */
  id: z.string(),
  title: z.string(),
  start: TimestampSchema,
  end: TimestampSchema,
  location: z.string().nullable(),
  audience: AudienceSchema,
  counterpartyClass: CounterpartyClassSchema,
  provenance: ProvenanceRefSchema,
  /** When the full prep is shown: 30 minutes before external, 10 before internal. */
  prepExpandsAt: TimestampSchema,
  attendees: z.array(AttendeeSchema),
  commitments: z.array(MeetingCommitmentSchema),
  documents: z.array(MeetingDocumentSchema),
  objectives: z.array(z.string()),
});

/** Spec 10.1 item 3: due today or overdue, deduplicated across sources. */
const TasksSchema = z.object({
  items: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      source: z.enum(['notion', 'jamie']),
      /** The planner's one line for why this task is in the top five. */
      reason: z.string(),
      due: z.string().nullable(),
      overdueDays: z.number().int().nullable(),
      url: z.string().url().nullable(),
    }),
  ),
  total: z.number().int().nonnegative(),
  duplicatesMerged: z.number().int().nonnegative(),
});

/** Spec 10.1 item 4: inbound commitments past their chase date. */
const WaitingForSchema = z.object({
  commitmentId: UlidSchema,
  description: z.string(),
  counterparty: z.string(),
  organisation: z.string().nullable(),
  dueAt: TimestampSchema.nullable(),
  overdueDays: z.number().int().nullable(),
  chaseCount: z.number().int().nonnegative(),
  chaseDueAt: TimestampSchema.nullable(),
  provenance: ProvenanceRefSchema,
  /** Set once a chase proposal exists, so the page does not offer a second one. */
  pendingChaseProposalId: UlidSchema.nullable(),
});

/** Spec 10.1 item 5: what happened while Dom was away. */
const OvernightSchema = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  alerts: z.array(
    z.object({
      alertId: z.string(),
      severity: AlertSeveritySchema,
      title: z.string(),
      at: TimestampSchema,
    }),
  ),
  awaiting: z.object({
    count: z.number().int().nonnegative(),
    top: z.array(
      z.object({
        proposalId: UlidSchema,
        preview: z.string(),
        actionClass: ActionClassSchema,
        expiresAt: TimestampSchema,
      }),
    ),
  }),
  executed: z.array(z.object({ summary: z.string(), correlationId: UlidSchema })),
});

/** Spec 10.1 item 6: watcher ages, breaker states, cost. */
const AgentHealthSchema = z.object({
  watchers: z.array(
    z.object({
      name: z.string(),
      ageMinutes: z.number().int().nonnegative(),
      state: z.enum(['healthy', 'stale', 'breaker_open', 'paused']),
    }),
  ),
  breakersOpen: z.number().int().nonnegative(),
  costYesterdayGbp: z.number().nonnegative(),
  costTodayGbp: z.number().nonnegative(),
  ceilingGbp: z.number().positive(),
});

export const MorningBriefContentSchema = z.object({
  date: LocalDateSchema,
  /** One sentence, for example "Three meetings, one of them external. Two things overdue." */
  headline: z.string(),
  dayShape: DayShapeSchema,
  meetings: z.array(MeetingSchema),
  tasks: TasksSchema,
  waitingFor: z.array(WaitingForSchema),
  overnight: OvernightSchema,
  agentHealth: AgentHealthSchema,
});
export type MorningBriefContent = z.infer<typeof MorningBriefContentSchema>;

export const AfternoonBoardContentSchema = z.object({
  /** The morning brief's `generatedAt`: everything below moved after it. */
  since: TimestampSchema,
  moved: z.object({
    tasksCompleted: z.array(
      z.object({ taskId: z.string(), title: z.string(), url: z.string().url().nullable() }),
    ),
    proposalsDecided: z.object({
      approved: z.number().int().nonnegative(),
      edited: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
    }),
    commitmentsClosed: z.array(z.object({ commitmentId: UlidSchema, description: z.string() })),
  }),
  pending: z.array(
    z.object({ proposalId: UlidSchema, preview: z.string(), expiresAt: TimestampSchema }),
  ),
  tomorrowFirstMeeting: z
    .object({
      title: z.string(),
      start: TimestampSchema,
      audience: AudienceSchema,
      counterpartyClass: CounterpartyClassSchema,
      attendees: z.array(z.string()),
      provenance: ProvenanceRefSchema,
      prepExists: z.boolean(),
      prepBriefId: UlidSchema.nullable(),
    })
    .nullable(),
});
export type AfternoonBoardContent = z.infer<typeof AfternoonBoardContentSchema>;
