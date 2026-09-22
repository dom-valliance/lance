import {
  agentRuns,
  alerts,
  commitments,
  cursors,
  observations,
  proposals,
  type Db,
} from '@lance/db';
import type { OntologyRepository } from '@lance/ontology';
import { organisationDomain } from '@lance/ontology';
import type { Config, ProvenanceRef } from '@lance/shared';
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { addDays, instantOf, localDate, startOfLocalDay } from './local.js';
import type {
  AfternoonBoard,
  CommitmentLine,
  MeetingSection,
  MorningBrief,
  TaskLine,
} from './schema.js';

/**
 * Deterministic assembly of everything a brief says (spec 10.1, 10.2):
 * the calendar, the people in it resolved through the ontology, what has
 * passed with them lately, open commitments, tasks, overnight activity
 * and agent health. The Planner reads this and adds judgement; it never
 * adds a fact.
 */

export interface BriefDataDeps {
  db: Db;
  ontology: OntologyRepository;
  config: Pick<Config, 'timeZone' | 'dom' | 'briefs' | 'cost'>;
  now: () => string;
}

interface LatestObservation {
  id: string;
  ts: Date;
  sourceSystem: string;
  sourceRecordId: string;
  sourceRecordHash: string;
  payload: Record<string, unknown>;
}

function provenanceOf(row: LatestObservation): ProvenanceRef {
  const url = row.payload['url'];
  return {
    system: row.sourceSystem as ProvenanceRef['system'],
    recordId: row.sourceRecordId,
    hash: row.sourceRecordHash,
    observedAt: row.ts.toISOString(),
    ...(typeof url === 'string' ? { url } : {}),
  };
}

/** The newest observation per source record for one watcher. */
async function latestByWatcher(
  db: Db,
  watcher: string,
  since?: Date,
): Promise<LatestObservation[]> {
  const rows = await db
    .selectDistinctOn([observations.sourceRecordId], {
      id: observations.id,
      ts: observations.ts,
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      sourceRecordHash: observations.sourceRecordHash,
      payload: observations.payload,
    })
    .from(observations)
    .where(
      and(
        sql`${observations.payload} ->> 'watcher' = ${watcher}`,
        since === undefined ? undefined : gte(observations.ts, since),
      ),
    )
    .orderBy(observations.sourceRecordId, desc(observations.ts), desc(observations.id));
  return rows.map((row) => ({ ...row, payload: (row.payload ?? {}) as Record<string, unknown> }));
}

interface CalendarEvent {
  row: LatestObservation;
  id: string;
  subject: string;
  start: Date;
  end: Date | null;
  attendees: { name: string | null; address: string | null; responseStatus: string | null }[];
  organiser: { name: string | null; address: string | null } | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Calendar events starting within [from, to), newest observation each, not cancelled or removed. */
export async function calendarEvents(
  deps: BriefDataDeps,
  from: Date,
  to: Date,
): Promise<CalendarEvent[]> {
  const rows = await latestByWatcher(deps.db, 'graph-calendar');
  const events: CalendarEvent[] = [];
  for (const row of rows) {
    const p = row.payload;
    if (p['removed'] === true || p['isCancelled'] === true || p['isAllDay'] === true) continue;
    const start = instantOf(
      p['start'] as { dateTime: string; timeZone: string | null } | null,
      deps.config.timeZone,
    );
    if (start === null || start < from || start >= to) continue;
    const end = instantOf(
      p['end'] as { dateTime: string; timeZone: string | null } | null,
      deps.config.timeZone,
    );
    const attendees = Array.isArray(p['attendees'])
      ? (p['attendees'] as Record<string, unknown>[]).map((a) => ({
          name: str(a['name']),
          address: str(a['address']),
          responseStatus: str(a['responseStatus']),
        }))
      : [];
    const organiser = p['organizer'] as { name?: unknown; address?: unknown } | null;
    events.push({
      row,
      id: row.sourceRecordId,
      subject: str(p['subject']) ?? '(no subject)',
      start,
      end,
      attendees,
      organiser:
        organiser === null || organiser === undefined
          ? null
          : { name: str(organiser.name), address: str(organiser.address) },
    });
  }
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function homeDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

/** Mail and meetings with an address, newest first, capped. */
async function interactionsWith(
  deps: BriefDataDeps,
  email: string,
  limit: number,
): Promise<MeetingSection['lastInteractions']> {
  const needle = email.toLowerCase();
  const rows = await deps.db
    .select({
      id: observations.id,
      ts: observations.ts,
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      sourceRecordHash: observations.sourceRecordHash,
      payload: observations.payload,
    })
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['graph', 'jamie']),
        sql`lower(${observations.payload}::text) like ${`%${needle}%`}`,
        sql`${observations.payload} ->> 'watcher' in ('graph-mail', 'jamie')`,
      ),
    )
    .orderBy(desc(observations.ts))
    .limit(limit * 3);
  const seen = new Set<string>();
  const out: MeetingSection['lastInteractions'] = [];
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (seen.has(row.sourceRecordId)) continue;
    seen.add(row.sourceRecordId);
    const kind = row.sourceSystem === 'jamie' ? 'meeting' : 'mail';
    const summary = str(p['summary']) ?? str(p['subject']) ?? str(p['title']) ?? kind;
    out.push({
      kind,
      at: row.ts.toISOString(),
      summary,
      provenance: [provenanceOf({ ...row, payload: p })],
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function commitmentLines(
  deps: BriefDataDeps,
  rows: (typeof commitments.$inferSelect)[],
): Promise<CommitmentLine[]> {
  const nowMs = new Date(deps.now()).getTime();
  const out: CommitmentLine[] = [];
  for (const row of rows) {
    const otherId = row.direction === 'outbound' ? row.counterpartyPersonId : row.ownerPersonId;
    const node = await deps.ontology.getNode(otherId);
    const counterparty =
      typeof node?.properties['display_name'] === 'string'
        ? node.properties['display_name']
        : otherId;
    const daysOverdue =
      row.dueAt === null || row.dueAt.getTime() > nowMs
        ? null
        : Math.floor((nowMs - row.dueAt.getTime()) / (24 * 3600 * 1000));
    out.push({
      id: row.id,
      direction: row.direction,
      description: row.description,
      counterparty,
      dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
      daysOverdue,
      provenance: (Array.isArray(row.sourceRefs) ? row.sourceRefs : []) as ProvenanceRef[],
    });
  }
  return out;
}

async function meetingSection(deps: BriefDataDeps, event: CalendarEvent): Promise<MeetingSection> {
  const home = homeDomain(deps.config.dom.email);
  const attendees: MeetingSection['attendees'] = [];
  const unknown: string[] = [];
  const personIds: string[] = [];
  let isExternal = false;
  const people = [
    ...event.attendees,
    ...(event.organiser === null ? [] : [{ ...event.organiser, responseStatus: null }]),
  ];
  const seen = new Set<string>();
  for (const person of people) {
    const email = person.address?.toLowerCase() ?? null;
    if (email !== null && seen.has(email)) continue;
    if (email !== null) seen.add(email);
    if (email === deps.config.dom.email.toLowerCase()) continue;
    const domain = email === null ? null : homeDomain(email);
    if (domain !== null && domain !== home) isExternal = true;
    const node = email === null ? null : await deps.ontology.findPersonByEmail(email);
    let organisation: string | null = null;
    if (node !== null) {
      personIds.push(node.id);
      const org = (await deps.ontology.neighbours(node.id, 'WORKS_AT'))[0]?.node;
      organisation = typeof org?.properties['name'] === 'string' ? org.properties['name'] : null;
    }
    if (organisation === null && email !== null) {
      const orgDomain = organisationDomain(email);
      const org =
        orgDomain === null ? null : await deps.ontology.findOrganisationByDomain(orgDomain);
      organisation =
        typeof org?.properties['name'] === 'string' ? org.properties['name'] : orgDomain;
    }
    const name = person.name ?? email ?? 'unknown';
    if (node === null && domain !== home) unknown.push(name);
    attendees.push({ name, email, organisation, known: node !== null });
  }

  const lastInteractions: MeetingSection['lastInteractions'] = [];
  for (const attendee of attendees.slice(0, 6)) {
    if (attendee.email === null) continue;
    lastInteractions.push(...(await interactionsWith(deps, attendee.email, 3)));
  }
  lastInteractions.sort((a, b) => b.at.localeCompare(a.at));

  const openCommitments =
    personIds.length === 0
      ? []
      : await commitmentLines(
          deps,
          await deps.db
            .select()
            .from(commitments)
            .where(
              and(
                inArray(commitments.status, ['open', 'chased']),
                or(
                  inArray(commitments.ownerPersonId, personIds),
                  inArray(commitments.counterpartyPersonId, personIds),
                ),
              ),
            ),
        );

  // Transcripts in the last 30 days with any of these people.
  const documents: MeetingSection['documents'] = [];
  const since = addDays(new Date(deps.now()), -30);
  for (const attendee of attendees.slice(0, 6)) {
    if (attendee.email === null) continue;
    const rows = await deps.db
      .select({
        id: observations.id,
        ts: observations.ts,
        sourceSystem: observations.sourceSystem,
        sourceRecordId: observations.sourceRecordId,
        sourceRecordHash: observations.sourceRecordHash,
        payload: observations.payload,
      })
      .from(observations)
      .where(
        and(
          eq(observations.sourceSystem, 'jamie'),
          gte(observations.ts, since),
          sql`${observations.payload} ->> 'kind' = 'meeting'`,
          sql`${observations.payload} ->> 'transcriptReady' = 'true'`,
          sql`lower(${observations.payload}::text) like ${`%${attendee.email.toLowerCase()}%`}`,
        ),
      )
      .orderBy(desc(observations.ts))
      .limit(3);
    for (const row of rows) {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (documents.some((d) => d.provenance[0]?.recordId === row.sourceRecordId)) continue;
      documents.push({
        title: str(p['title']) ?? 'Meeting transcript',
        url: str(p['url']),
        provenance: [provenanceOf({ ...row, payload: p })],
      });
    }
  }

  return {
    eventId: event.id,
    subject: event.subject,
    start: event.start.toISOString(),
    end: event.end === null ? null : event.end.toISOString(),
    isExternal,
    attendees,
    unknownAttendees: unknown,
    lastInteractions: lastInteractions.slice(0, 9),
    openCommitments,
    documents,
    objectives: [],
    provenance: [provenanceOf(event.row)],
  };
}

function dayShape(
  events: CalendarEvent[],
  dayStart: Date,
  dayEnd: Date,
  minFreeHours: number,
): MorningBrief['dayShape'] {
  if (events.length === 0) {
    return {
      firstMeeting: null,
      lastMeeting: null,
      meetingHours: 0,
      longestFreeBlockHours: 24,
      freeTimeShort: false,
    };
  }
  let meetingMs = 0;
  let longestFree = 0;
  // Working day 08:00 to 18:00 local for the free block calculation.
  const workStart = new Date(dayStart.getTime() + 8 * 3600 * 1000);
  const workEnd = new Date(dayStart.getTime() + 18 * 3600 * 1000);
  let cursor = workStart;
  for (const event of events) {
    const end = event.end ?? new Date(event.start.getTime() + 30 * 60 * 1000);
    meetingMs += Math.max(0, end.getTime() - event.start.getTime());
    if (event.start > cursor)
      longestFree = Math.max(longestFree, event.start.getTime() - cursor.getTime());
    if (end > cursor) cursor = end;
  }
  if (workEnd > cursor) longestFree = Math.max(longestFree, workEnd.getTime() - cursor.getTime());
  const longestFreeHours = Math.round((longestFree / 3600000) * 10) / 10;
  const last = events[events.length - 1];
  return {
    firstMeeting: events[0]?.start.toISOString() ?? null,
    lastMeeting: (last?.end ?? last?.start)?.toISOString() ?? null,
    meetingHours: Math.round((meetingMs / 3600000) * 10) / 10,
    longestFreeBlockHours: longestFreeHours,
    freeTimeShort: longestFreeHours < minFreeHours && dayEnd > dayStart,
  };
}

/** Tasks due today or overdue across Notion and Jamie, newest observation per record, not done. */
export async function tasksDue(deps: BriefDataDeps, today: string): Promise<TaskLine[]> {
  const rows = await deps.db
    .selectDistinctOn([observations.sourceRecordId], {
      id: observations.id,
      ts: observations.ts,
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      sourceRecordHash: observations.sourceRecordHash,
      payload: observations.payload,
    })
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['notion', 'jamie']),
        sql`${observations.payload} ->> 'kind' = 'task'`,
      ),
    )
    .orderBy(observations.sourceRecordId, desc(observations.ts), desc(observations.id));
  const out: TaskLine[] = [];
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const source = row.sourceSystem as 'notion' | 'jamie';
    const done =
      source === 'jamie'
        ? p['completed'] === true
        : ['Done', 'Cancelled', 'Archived'].includes(str(p['status']) ?? '');
    if (done) continue;
    const due = str(p['due']) ?? str(p['dueDate']) ?? null;
    if (due === null || due.slice(0, 10) > today) continue;
    out.push({
      id: `${source}:${row.sourceRecordId}`,
      source,
      title: str(p['title']) ?? str(p['text']) ?? '(untitled)',
      due: due.slice(0, 10),
      overdue: due.slice(0, 10) < today,
      url: str(p['url']),
      reason: null,
      provenance: [provenanceOf({ ...row, payload: p })],
    });
  }
  return out.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
}

export async function assembleMorningBrief(deps: BriefDataDeps): Promise<MorningBrief> {
  const now = new Date(deps.now());
  const zone = deps.config.timeZone;
  const dayStart = startOfLocalDay(now, zone);
  const dayEnd = addDays(dayStart, 1);
  const today = localDate(now, zone);

  const events = await calendarEvents(deps, dayStart, dayEnd);
  const meetings: MeetingSection[] = [];
  for (const event of events) meetings.push(await meetingSection(deps, event));

  const tasks = await tasksDue(deps, today);

  const waiting = await commitmentLines(
    deps,
    await deps.db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.direction, 'inbound'),
          inArray(commitments.status, ['open', 'chased']),
          sql`${commitments.nextChaseAt} <= ${now}`,
        ),
      ),
  );

  const since = new Date(dayStart.getTime() - 5 * 3600 * 1000); // 19:00 the day before
  const overnightAlerts = await deps.db
    .select()
    .from(alerts)
    .where(and(gte(alerts.lastSeen, since), inArray(alerts.status, ['open', 'acked'])))
    .orderBy(desc(alerts.lastSeen));
  const pending = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.status, 'pending'))
    .orderBy(desc(proposals.createdAt));
  const executedAuto = await deps.db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.status, 'executed'),
        eq(proposals.decidedBy, 'system:policy'),
        gte(proposals.updatedAt, since),
      ),
    )
    .orderBy(desc(proposals.updatedAt));

  const cursorRows = await deps.db.select().from(cursors);
  const byWatcher = new Map<string, Date>();
  for (const row of cursorRows) {
    if (row.key === '__started_at') continue;
    const prev = byWatcher.get(row.watcher);
    if (prev === undefined || row.updatedAt > prev) byWatcher.set(row.watcher, row.updatedAt);
  }
  const watchers = [...byWatcher.entries()].map(([name, at]) => ({
    name,
    ageMinutes: Math.round((now.getTime() - at.getTime()) / 60000),
  }));
  const yesterdayStart = addDays(dayStart, -1);
  const cost = await deps.db
    .select({ total: sql<string>`coalesce(sum(${agentRuns.estimatedCostUsd}), 0)::text` })
    .from(agentRuns)
    .where(and(gte(agentRuns.startedAt, yesterdayStart), lt(agentRuns.startedAt, dayStart)));
  const costYesterdayGbp =
    Math.round(Number(cost[0]?.total ?? '0') * deps.config.cost.usdToGbp * 100) / 100;
  const stale = watchers
    .filter((w) => w.ageMinutes !== null && w.ageMinutes > 120)
    .map((w) => w.name);
  const line =
    `${String(watchers.length)} watchers` +
    (stale.length === 0 ? ' current' : `, stale: ${stale.join(', ')}`) +
    `; yesterday cost GBP ${costYesterdayGbp.toFixed(2)}.`;

  return {
    date: today,
    dayShape: dayShape(events, dayStart, dayEnd, deps.config.briefs.minFreeBlockHours),
    meetings,
    tasks,
    waitingFor: waiting,
    overnight: {
      alerts: overnightAlerts.map((a) => ({
        id: a.id,
        severity: a.severity,
        title: a.title,
        provenance: (Array.isArray(a.provenance) ? a.provenance : []) as ProvenanceRef[],
      })),
      pendingProposals: {
        count: pending.length,
        top: pending.slice(0, 3).map((p) => ({
          id: p.id,
          preview: p.preview,
          provenance: p.provenance as ProvenanceRef[],
        })),
      },
      executedAuto: executedAuto.map((p) => ({
        id: p.id,
        preview: p.preview,
        provenance: p.provenance as ProvenanceRef[],
      })),
    },
    agentHealth: { watchers, costYesterdayGbp, line },
    holdProposalIds: [],
    slackThreads: {},
  };
}

/** What moved since the morning brief (spec 10.2). */
export async function assembleAfternoonBoard(
  deps: BriefDataDeps,
  since: Date,
): Promise<AfternoonBoard> {
  const now = new Date(deps.now());
  const zone = deps.config.timeZone;
  const today = localDate(now, zone);

  const taskRows = await deps.db
    .select({
      id: observations.id,
      ts: observations.ts,
      sourceSystem: observations.sourceSystem,
      sourceRecordId: observations.sourceRecordId,
      sourceRecordHash: observations.sourceRecordHash,
      payload: observations.payload,
    })
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['notion', 'jamie']),
        gte(observations.ts, since),
        sql`${observations.payload} ->> 'kind' = 'task'`,
      ),
    )
    .orderBy(desc(observations.ts));
  const tasksCompleted: TaskLine[] = [];
  const seenTasks = new Set<string>();
  for (const row of taskRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (seenTasks.has(row.sourceRecordId)) continue;
    seenTasks.add(row.sourceRecordId);
    const source = row.sourceSystem as 'notion' | 'jamie';
    const done =
      source === 'jamie'
        ? p['completed'] === true
        : ['Done', 'Cancelled', 'Archived'].includes(str(p['status']) ?? '');
    if (!done) continue;
    tasksCompleted.push({
      id: `${source}:${row.sourceRecordId}`,
      source,
      title: str(p['title']) ?? str(p['text']) ?? '(untitled)',
      due: (str(p['due']) ?? '').slice(0, 10) || null,
      overdue: false,
      url: str(p['url']),
      reason: null,
      provenance: [provenanceOf({ ...row, payload: p })],
    });
  }

  const decided = await deps.db
    .select()
    .from(proposals)
    .where(
      and(
        gte(proposals.decidedAt, since),
        inArray(proposals.status, ['approved', 'edited', 'rejected', 'executed', 'failed']),
      ),
    )
    .orderBy(desc(proposals.decidedAt));
  const closed = await commitmentLines(
    deps,
    await deps.db
      .select()
      .from(commitments)
      .where(
        and(gte(commitments.updatedAt, since), inArray(commitments.status, ['done', 'dropped'])),
      ),
  );
  const pending = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.status, 'pending'))
    .orderBy(desc(proposals.createdAt));

  const tomorrowStart = addDays(startOfLocalDay(now, zone), 1);
  const tomorrow = (await calendarEvents(deps, tomorrowStart, addDays(tomorrowStart, 1)))[0];
  let tomorrowFirstMeeting: AfternoonBoard['tomorrowFirstMeeting'] = null;
  if (tomorrow !== undefined) {
    const prep = await deps.db
      .select({ id: sql<string>`id` })
      .from(sql`briefs`)
      .where(sql`kind = 'meeting_prep' and content ->> 'eventId' = ${tomorrow.id}`)
      .limit(1);
    tomorrowFirstMeeting = {
      subject: tomorrow.subject,
      start: tomorrow.start.toISOString(),
      prepExists: prep.length > 0,
      provenance: [provenanceOf(tomorrow.row)],
    };
  }

  return {
    date: today,
    since: since.toISOString(),
    tasksCompleted,
    proposalsDecided: decided.map((p) => ({
      id: p.id,
      preview: p.preview,
      status: p.status,
      provenance: p.provenance as ProvenanceRef[],
    })),
    commitmentsClosed: closed,
    pendingDecision: pending.map((p) => ({
      id: p.id,
      preview: p.preview,
      provenance: p.provenance as ProvenanceRef[],
    })),
    tomorrowFirstMeeting,
  };
}
