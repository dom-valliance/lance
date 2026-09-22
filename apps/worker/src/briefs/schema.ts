import { ProvenanceRefSchema } from '@lance/shared';
import { z } from 'zod';

/**
 * The morning brief (spec 10.1) as stored in `briefs.content` and rendered
 * to Slack and the Today page. Every line carries provenance (non-negotiable
 * 5). The deterministic assembly in `data.ts` fills everything except the
 * objectives and the task reasons, which the Planner adds.
 */

export const PersonLineSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  organisation: z.string().nullable(),
  /** False when the ontology has never seen this person (spec 10.1 item 2). */
  known: z.boolean(),
});

export const InteractionSchema = z.object({
  kind: z.enum(['mail', 'meeting']),
  at: z.string(),
  summary: z.string(),
  provenance: z.array(ProvenanceRefSchema),
});

export const CommitmentLineSchema = z.object({
  id: z.string(),
  direction: z.enum(['outbound', 'inbound']),
  description: z.string(),
  counterparty: z.string(),
  dueAt: z.string().nullable(),
  daysOverdue: z.number().int().nullable(),
  provenance: z.array(ProvenanceRefSchema),
});

export const MeetingSectionSchema = z.object({
  eventId: z.string(),
  subject: z.string(),
  start: z.string(),
  end: z.string().nullable(),
  isExternal: z.boolean(),
  attendees: z.array(PersonLineSchema),
  unknownAttendees: z.array(z.string()),
  lastInteractions: z.array(InteractionSchema),
  openCommitments: z.array(CommitmentLineSchema),
  /** Transcripts and documents referenced in the last 30 days with these people or this organisation. */
  documents: z.array(
    z.object({
      title: z.string(),
      url: z.string().nullable(),
      provenance: z.array(ProvenanceRefSchema),
    }),
  ),
  /** Two, from the Planner. Empty until it runs. */
  objectives: z.array(z.string()).max(2),
  provenance: z.array(ProvenanceRefSchema),
});

export const TaskLineSchema = z.object({
  id: z.string(),
  source: z.enum(['notion', 'jamie']),
  title: z.string(),
  due: z.string().nullable(),
  overdue: z.boolean(),
  url: z.string().nullable(),
  /** From the Planner, one line. */
  reason: z.string().nullable(),
  provenance: z.array(ProvenanceRefSchema),
});

export const DayShapeSchema = z.object({
  firstMeeting: z.string().nullable(),
  lastMeeting: z.string().nullable(),
  meetingHours: z.number(),
  longestFreeBlockHours: z.number(),
  /** Below `briefs.minFreeBlockHours`; the Planner proposes holds. */
  freeTimeShort: z.boolean(),
});

export const OvernightSchema = z.object({
  alerts: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['P0', 'P1', 'P2']),
      title: z.string(),
      provenance: z.array(ProvenanceRefSchema),
    }),
  ),
  pendingProposals: z.object({
    count: z.number().int(),
    top: z.array(
      z.object({ id: z.string(), preview: z.string(), provenance: z.array(ProvenanceRefSchema) }),
    ),
  }),
  executedAuto: z.array(
    z.object({ id: z.string(), preview: z.string(), provenance: z.array(ProvenanceRefSchema) }),
  ),
});

export const AgentHealthSchema = z.object({
  watchers: z.array(z.object({ name: z.string(), ageMinutes: z.number().nullable() })),
  costYesterdayGbp: z.number(),
  line: z.string(),
});

export const MorningBriefSchema = z.object({
  date: z.string(),
  dayShape: DayShapeSchema,
  meetings: z.array(MeetingSectionSchema),
  tasks: z.array(TaskLineSchema),
  waitingFor: z.array(CommitmentLineSchema),
  overnight: OvernightSchema,
  agentHealth: AgentHealthSchema,
  /** Proposal ids the Planner created for calendar holds. */
  holdProposalIds: z.array(z.string()),
  /** Slack thread ts per meeting event id, so meeting prep can reply under the right entry. */
  slackThreads: z.record(z.string(), z.string()).default({}),
});

export type MorningBrief = z.infer<typeof MorningBriefSchema>;
export type MeetingSection = z.infer<typeof MeetingSectionSchema>;
export type TaskLine = z.infer<typeof TaskLineSchema>;
export type CommitmentLine = z.infer<typeof CommitmentLineSchema>;

/** What the Planner returns (spec 7.3): judgement over the assembled facts, never new facts. */
export const PlannerOutputSchema = z.object({
  meetings: z.array(
    z.object({
      eventId: z.string(),
      objectives: z.array(z.string().min(1).max(200)).min(1).max(2),
    }),
  ),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        rank: z.number().int().min(1).max(5),
        reason: z.string().min(1).max(200),
      }),
    )
    .max(5),
  holdsProposed: z.number().int().min(0),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/** The afternoon board (spec 10.2): what moved since the brief. Deterministic. */
export const AfternoonBoardSchema = z.object({
  date: z.string(),
  since: z.string(),
  tasksCompleted: z.array(TaskLineSchema),
  proposalsDecided: z.array(
    z.object({
      id: z.string(),
      preview: z.string(),
      status: z.string(),
      provenance: z.array(ProvenanceRefSchema),
    }),
  ),
  commitmentsClosed: z.array(CommitmentLineSchema),
  pendingDecision: z.array(
    z.object({ id: z.string(), preview: z.string(), provenance: z.array(ProvenanceRefSchema) }),
  ),
  tomorrowFirstMeeting: z
    .object({
      subject: z.string(),
      start: z.string(),
      prepExists: z.boolean(),
      provenance: z.array(ProvenanceRefSchema),
    })
    .nullable(),
});

export type AfternoonBoard = z.infer<typeof AfternoonBoardSchema>;
