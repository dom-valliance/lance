import { describe, expect, it } from 'vitest';
import {
  AfternoonBoardContentSchema,
  MorningBriefContentSchema,
  type AfternoonBoardContent,
  type MorningBriefContent,
} from './briefs.js';

/**
 * One full example of each brief content, as the planner writes it, plus a
 * proof that a missing field is rejected rather than reaching the Today
 * page as a hole.
 */

const provenance = {
  system: 'graph' as const,
  recordId: 'AAMk1',
  hash: 'sha256:aamk1',
  observedAt: '2026-09-22T05:30:00.000Z',
};

const morningBrief: MorningBriefContent = {
  date: '2026-09-22',
  headline: 'Three meetings, one of them external. Two things overdue.',
  dayShape: {
    firstMeeting: { start: '2026-09-22T08:00:00.000Z', title: 'Pilot kick-off' },
    lastMeeting: { start: '2026-09-22T15:00:00.000Z', title: 'Weekly sync' },
    meetingHours: 3.5,
    workingHours: 8,
    longestFreeBlock: {
      start: '2026-09-22T09:00:00.000Z',
      end: '2026-09-22T12:00:00.000Z',
      hours: 3,
    },
    proposedHolds: [],
    note: 'No holds proposed: free time is over two hours.',
    calendarObservedAt: '2026-09-22T05:30:00.000Z',
  },
  meetings: [
    {
      id: 'AAMk1',
      title: 'Pilot kick-off',
      start: '2026-09-22T08:00:00.000Z',
      end: '2026-09-22T09:00:00.000Z',
      location: 'Teams',
      audience: 'external',
      counterpartyClass: 'client',
      provenance,
      prepExpandsAt: '2026-09-22T07:30:00.000Z',
      attendees: [
        {
          personId: 'per-ann',
          name: 'Ann Example',
          role: 'Head of Data',
          organisation: 'Example Ltd',
          email: 'ann@client.test',
          unknown: false,
          interactions: [
            {
              kind: 'mail',
              at: '2026-09-19T11:00:00.000Z',
              summary: 'Asked for the pilot dates.',
              provenance,
            },
          ],
        },
      ],
      commitments: [
        {
          commitmentId: '01K5S9V6QW3SWCCPVB0N0E302A',
          direction: 'inbound',
          description: 'Send the signed order form',
          dueAt: '2026-09-18T17:00:00.000Z',
          overdueDays: 4,
        },
      ],
      documents: [
        {
          title: 'Pilot scope',
          source: 'notion',
          editedAt: '2026-09-20T16:00:00.000Z',
          url: 'https://www.notion.so/20257534',
        },
      ],
      objectives: ['Agree the pilot dates', 'Confirm the data feed owner'],
    },
  ],
  tasks: {
    items: [
      {
        taskId: '20257534-6e48-81fe-b4b5-000b69ecace7',
        title: 'Draft the pilot scope',
        source: 'notion',
        reason: 'Due today and blocks the kick-off.',
        due: '2026-09-22',
        overdueDays: null,
        url: 'https://www.notion.so/20257534',
      },
    ],
    total: 7,
    duplicatesMerged: 2,
  },
  waitingFor: [
    {
      commitmentId: '01K5S9V6QW3SWCCPVB0N0E302A',
      description: 'Send the signed order form',
      counterparty: 'Ann Example',
      organisation: 'Example Ltd',
      dueAt: '2026-09-18T17:00:00.000Z',
      overdueDays: 4,
      chaseCount: 1,
      chaseDueAt: '2026-09-22T09:00:00.000Z',
      provenance,
      pendingChaseProposalId: null,
    },
  ],
  overnight: {
    from: '2026-09-21T18:00:00.000Z',
    to: '2026-09-22T05:30:00.000Z',
    alerts: [
      {
        alertId: '01K5S9V6QW3SWCCPVB0N0E304A',
        severity: 'P2',
        title: 'Graph token refresh took two attempts',
        at: '2026-09-22T02:14:00.000Z',
      },
    ],
    awaiting: {
      count: 3,
      top: [
        {
          proposalId: '01K5S9V6QW3SWCCPVB0N0E301A',
          preview: 'Reply to "the pilot"',
          actionClass: 'draft_email',
          expiresAt: '2026-09-23T09:00:00.000Z',
        },
      ],
    },
    executed: [{ summary: 'Created one Notion task', correlationId: '01K5S9V6QW3SWCCPVB0N0E301B' }],
  },
  agentHealth: {
    watchers: [{ name: 'graph-mail', ageMinutes: 12, state: 'healthy' }],
    breakersOpen: 0,
    costYesterdayGbp: 1.42,
    costTodayGbp: 0.08,
    ceilingGbp: 10,
  },
};

const afternoonBoard: AfternoonBoardContent = {
  since: '2026-09-22T05:30:00.000Z',
  moved: {
    tasksCompleted: [
      {
        taskId: '20257534-6e48-81fe-b4b5-000b69ecace7',
        title: 'Draft the pilot scope',
        url: 'https://www.notion.so/20257534',
      },
    ],
    proposalsDecided: { approved: 2, edited: 1, rejected: 0 },
    commitmentsClosed: [
      { commitmentId: '01K5S9V6QW3SWCCPVB0N0E302A', description: 'Send the signed order form' },
    ],
  },
  pending: [
    {
      proposalId: '01K5S9V6QW3SWCCPVB0N0E301A',
      preview: 'Reply to "the pilot"',
      expiresAt: '2026-09-23T09:00:00.000Z',
    },
  ],
  tomorrowFirstMeeting: {
    title: 'Weekly sync',
    start: '2026-09-23T08:00:00.000Z',
    audience: 'internal',
    counterpartyClass: 'internal',
    attendees: ['Ann Example'],
    provenance,
    prepExists: true,
    prepBriefId: '01K5S9V6QW3SWCCPVB0N0E305A',
  },
};

describe('MorningBriefContentSchema', () => {
  it('parses a full morning brief', () => {
    expect(MorningBriefContentSchema.parse(morningBrief)).toEqual(morningBrief);
  });

  it('rejects a brief whose day shape has no calendar observation time', () => {
    const { calendarObservedAt, ...dayShape } = morningBrief.dayShape;
    void calendarObservedAt;

    const result = MorningBriefContentSchema.safeParse({ ...morningBrief, dayShape });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['dayShape', 'calendarObservedAt']);
  });
});

describe('AfternoonBoardContentSchema', () => {
  it('parses a full afternoon board', () => {
    expect(AfternoonBoardContentSchema.parse(afternoonBoard)).toEqual(afternoonBoard);
  });

  it('accepts a board with no meeting tomorrow', () => {
    const parsed = AfternoonBoardContentSchema.parse({
      ...afternoonBoard,
      tomorrowFirstMeeting: null,
    });

    expect(parsed.tomorrowFirstMeeting).toBeNull();
  });

  it('rejects a board with no pending list', () => {
    const { pending, ...rest } = afternoonBoard;
    void pending;

    const result = AfternoonBoardContentSchema.safeParse(rest);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['pending']);
  });
});
