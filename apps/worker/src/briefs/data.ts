import {
  agentRuns,
  alerts,
  briefs,
  commitments,
  cursors,
  newestObservationFirst,
  observations,
  proposals,
  type Db,
} from '@lance/db';
import { TASK_CLOSED_STATUSES } from '@lance/connectors';
import type { OntologyRepository } from '@lance/ontology';
import { organisationDomain } from '@lance/ontology';
import type {
  AfternoonBoardContent,
  Config,
  CounterpartyClass,
  MorningBriefContent,
  ProvenanceRef,
} from '@lance/shared';
import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { addDays, instantOf, localDate, startOfLocalDay } from './local.js';

/**
 * Deterministic assembly of everything a brief says (spec 10.1, 10.2), in
 * the shapes `packages/shared/src/briefs.ts` fixes for the api and the
 * Today page: the calendar, the people in it resolved through the
 * ontology, what has passed with them lately, open commitments, tasks,
 * overnight activity and agent health. The Planner reads this and adds
 * judgement; it never adds a fact.
 */

export interface BriefDataDeps {
  db: Db;
  ontology: OntologyRepository;
  config: Pick<Config, 'timeZone' | 'dom' | 'briefs' | 'cost' | 'notion'>;
  now: () => string;
}

/** The working day the free block calculation looks at, local hours. */
const WORKING_DAY = { startHour: 8, endHour: 18 } as const;
const WORKING_HOURS = WORKING_DAY.endHour - WORKING_DAY.startHour;
/** Spec 9.1: prep expands 30 minutes before an external meeting, 10 before an internal one. */
export const PREP_LEAD_MINUTES = { external: 30, internal: 10 } as const;
const MAX_INTERACTIONS_PER_PERSON = 3;

type Meeting = MorningBriefContent['meetings'][number];
type Attendee = Meeting['attendees'][number];
type Interaction = Attendee['interactions'][number];

interface LatestObservation {
  id: string;
  ts: Date;
  sourceSystem: string;
  sourceRecordId: string;
  sourceRecordHash: string;
  payload: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function validUrl(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

function provenanceOf(row: LatestObservation): ProvenanceRef {
  const url = validUrl(row.payload['url']);
  return {
    system: row.sourceSystem as ProvenanceRef['system'],
    recordId: row.sourceRecordId,
    hash: row.sourceRecordHash,
    observedAt: row.ts.toISOString(),
    ...(url === null ? {} : { url }),
  };
}

const OBSERVATION_COLUMNS = {
  id: observations.id,
  ts: observations.ts,
  sourceSystem: observations.sourceSystem,
  sourceRecordId: observations.sourceRecordId,
  sourceRecordHash: observations.sourceRecordHash,
  payload: observations.payload,
};

/** The newest observation per source record for one watcher. */
async function latestByWatcher(db: Db, watcher: string): Promise<LatestObservation[]> {
  const rows = await db
    .selectDistinctOn([observations.sourceRecordId], OBSERVATION_COLUMNS)
    .from(observations)
    .where(sql`${observations.payload} ->> 'watcher' = ${watcher}`)
    .orderBy(...newestObservationFirst());
  return rows.map((row) => ({ ...row, payload: (row.payload ?? {}) as Record<string, unknown> }));
}

export interface CalendarEvent {
  row: LatestObservation;
  id: string;
  subject: string;
  start: Date;
  end: Date;
  location: string | null;
  attendees: { name: string | null; address: string | null; responseStatus: string | null }[];
  organiser: { name: string | null; address: string | null } | null;
}

/** Calendar events starting within [from, to), newest observation each, not cancelled, removed or all day. */
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
    const end =
      instantOf(
        p['end'] as { dateTime: string; timeZone: string | null } | null,
        deps.config.timeZone,
      ) ?? new Date(start.getTime() + 30 * 60 * 1000);
    const attendees = Array.isArray(p['attendees'])
      ? (p['attendees'] as Record<string, unknown>[]).map((a) => ({
          name: str(a['name']),
          address: str(a['address']),
          responseStatus: str(a['responseStatus']),
        }))
      : [];
    const organiser = p['organizer'] as { name?: unknown; address?: unknown } | null | undefined;
    events.push({
      row,
      id: row.sourceRecordId,
      subject: str(p['subject']) ?? '(no subject)',
      start,
      end,
      location: str(p['location']),
      attendees,
      organiser:
        organiser === null || organiser === undefined
          ? null
          : { name: str(organiser.name), address: str(organiser.address) },
    });
  }
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

/** Mail and meetings with an address, newest first, one per record. */
async function interactionsWith(deps: BriefDataDeps, email: string): Promise<Interaction[]> {
  const needle = email.toLowerCase();
  const rows = await deps.db
    .select(OBSERVATION_COLUMNS)
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['graph', 'jamie']),
        sql`${observations.payload} ->> 'watcher' in ('graph-mail', 'jamie')`,
        sql`lower(${observations.payload}::text) like ${`%${needle}%`}`,
      ),
    )
    .orderBy(desc(observations.ts))
    .limit(MAX_INTERACTIONS_PER_PERSON * 3);
  const seen = new Set<string>();
  const out: Interaction[] = [];
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (seen.has(row.sourceRecordId)) continue;
    seen.add(row.sourceRecordId);
    const kind: Interaction['kind'] =
      row.sourceSystem === 'jamie'
        ? p['transcriptReady'] === true
          ? 'transcript'
          : 'meeting'
        : 'mail';
    // Only the watcher's capped summary or the subject: never a body.
    const summary = str(p['summary']) ?? str(p['subject']) ?? str(p['title']) ?? kind;
    out.push({
      kind,
      at: row.ts.toISOString(),
      summary,
      provenance: provenanceOf({ ...row, payload: p }),
    });
    if (out.length >= MAX_INTERACTIONS_PER_PERSON) break;
  }
  return out;
}

async function personName(deps: BriefDataDeps, personId: string): Promise<string> {
  const node = await deps.ontology.getNode(personId);
  const name = node?.properties['display_name'];
  return typeof name === 'string' ? name : personId;
}

async function organisationOfPerson(
  deps: BriefDataDeps,
  personId: string | null,
  email: string | null,
): Promise<{ name: string | null; type: CounterpartyClass | null }> {
  if (personId !== null) {
    const org = (await deps.ontology.neighbours(personId, 'WORKS_AT'))[0]?.node;
    if (org !== undefined) {
      const type = org.properties['type'];
      return {
        name: typeof org.properties['name'] === 'string' ? org.properties['name'] : null,
        type: isCounterpartyClass(type) ? type : null,
      };
    }
  }
  const domain = email === null ? null : organisationDomain(email);
  if (domain === null) return { name: null, type: null };
  const org = await deps.ontology.findOrganisationByDomain(domain);
  if (org === null) return { name: domain, type: null };
  const type = org.properties['type'];
  return {
    name: typeof org.properties['name'] === 'string' ? org.properties['name'] : domain,
    type: isCounterpartyClass(type) ? type : null,
  };
}

function isCounterpartyClass(value: unknown): value is CounterpartyClass {
  return (
    value === 'client' ||
    value === 'prospect' ||
    value === 'partner' ||
    value === 'vendor' ||
    value === 'internal' ||
    value === 'unknown'
  );
}

/** The external attendees plus everyone the ontology knows at their organisations' domains. */
async function counterpartyPersonIds(
  deps: BriefDataDeps,
  attendeeIds: readonly string[],
  domains: ReadonlySet<string>,
): Promise<string[]> {
  const ids = new Set(attendeeIds);
  for (const domain of domains) {
    for (const node of await deps.ontology.findPersonsByEmailDomain(domain)) ids.add(node.id);
  }
  return [...ids];
}

async function meetingOf(deps: BriefDataDeps, event: CalendarEvent): Promise<Meeting> {
  const home = domainOf(deps.config.dom.email);
  const attendees: Attendee[] = [];
  const personIds: string[] = [];
  const externalPersonIds: string[] = [];
  const externalDomains = new Set<string>();
  let external = false;
  let counterpartyClass: CounterpartyClass = 'internal';
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
    const domain = email === null ? null : domainOf(email);
    const isExternal = domain !== null && domain !== home;
    if (isExternal) external = true;
    const node = email === null ? null : await deps.ontology.findPersonByEmail(email);
    if (node !== null) personIds.push(node.id);
    if (node !== null && isExternal) externalPersonIds.push(node.id);
    const organisationDomainOf = email === null ? null : organisationDomain(email);
    if (isExternal && organisationDomainOf !== null) externalDomains.add(organisationDomainOf);
    const organisation = await organisationOfPerson(deps, node?.id ?? null, email);
    if (isExternal && organisation.type !== null && organisation.type !== 'internal') {
      counterpartyClass = organisation.type;
    } else if (isExternal && counterpartyClass === 'internal') {
      counterpartyClass = 'unknown';
    }
    const role = node?.properties['role'];
    attendees.push({
      personId: node?.id ?? null,
      name: person.name ?? email ?? 'unknown',
      role: typeof role === 'string' ? role : null,
      organisation: organisation.name,
      email,
      unknown: node === null && isExternal,
      interactions: email === null ? [] : await interactionsWith(deps, email),
    });
  }

  // Spec 10.1 item 2: open commitments with those people or that
  // organisation. In an external meeting the counterparty is the external
  // side: its attendees and everyone else at their organisations. A
  // colleague in the room does not bring in what they owe or are owed from
  // every other meeting they sit in. In an internal meeting the colleagues
  // are the counterparty, so their commitments are the ones that matter.
  const commitmentPersonIds = external
    ? await counterpartyPersonIds(deps, externalPersonIds, externalDomains)
    : personIds;
  const openRows =
    commitmentPersonIds.length === 0
      ? []
      : await deps.db
          .select()
          .from(commitments)
          .where(
            and(
              inArray(commitments.status, ['open', 'chased']),
              or(
                inArray(commitments.ownerPersonId, commitmentPersonIds),
                inArray(commitments.counterpartyPersonId, commitmentPersonIds),
              ),
            ),
          );
  const nowMs = new Date(deps.now()).getTime();
  const meetingCommitments: Meeting['commitments'] = openRows.map((row) => ({
    commitmentId: row.id,
    direction: row.direction,
    description: row.description,
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
    overdueDays: overdueDays(row.dueAt, nowMs),
  }));

  // Transcripts in the last 30 days with any of these people.
  const documents: Meeting['documents'] = [];
  const since = addDays(new Date(deps.now()), -30);
  for (const attendee of attendees.slice(0, 6)) {
    if (attendee.email === null) continue;
    const rows = await deps.db
      .select(OBSERVATION_COLUMNS)
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
      if (documents.some((d) => d.url !== null && d.url === validUrl(p['url']))) continue;
      documents.push({
        title: str(p['title']) ?? 'Meeting transcript',
        source: 'jamie',
        editedAt: row.ts.toISOString(),
        url: validUrl(p['url']),
      });
    }
  }

  const lead = external ? PREP_LEAD_MINUTES.external : PREP_LEAD_MINUTES.internal;
  return {
    id: event.id,
    title: event.subject,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    location: event.location,
    audience: external ? 'external' : 'internal',
    counterpartyClass,
    provenance: provenanceOf(event.row),
    prepExpandsAt: new Date(event.start.getTime() - lead * 60 * 1000).toISOString(),
    attendees,
    commitments: meetingCommitments,
    documents,
    objectives: [],
  };
}

function overdueDays(dueAt: Date | null, nowMs: number): number | null {
  if (dueAt === null || dueAt.getTime() > nowMs) return null;
  return Math.floor((nowMs - dueAt.getTime()) / 86_400_000);
}

interface FreeBlock {
  start: Date;
  end: Date;
}

/** Spec 10.1 item 1, over the working day. */
export function dayShapeOf(
  events: CalendarEvent[],
  dayStart: Date,
  minFreeHours: number,
  calendarObservedAt: string,
): { shape: Omit<MorningBriefContent['dayShape'], 'proposedHolds'>; freeTimeShort: boolean } {
  const workStart = new Date(dayStart.getTime() + WORKING_DAY.startHour * 3600 * 1000);
  const workEnd = new Date(dayStart.getTime() + WORKING_DAY.endHour * 3600 * 1000);
  let meetingMs = 0;
  const free: FreeBlock[] = [];
  let cursor = workStart;
  for (const event of events) {
    meetingMs += Math.max(0, event.end.getTime() - event.start.getTime());
    if (event.start > cursor) free.push({ start: cursor, end: event.start });
    if (event.end > cursor) cursor = event.end;
  }
  if (workEnd > cursor) free.push({ start: cursor, end: workEnd });
  const lengthOf = (b: FreeBlock): number => b.end.getTime() - b.start.getTime();
  const block = free.reduce<FreeBlock | null>(
    (best, b) => (best === null || lengthOf(b) > lengthOf(best) ? b : best),
    null,
  );
  const hours =
    block === null
      ? 0
      : Math.round(((block.end.getTime() - block.start.getTime()) / 3_600_000) * 10) / 10;
  const first = events[0];
  const last = events[events.length - 1];
  const freeTimeShort = events.length > 0 && hours < minFreeHours;
  return {
    shape: {
      firstMeeting:
        first === undefined ? null : { start: first.start.toISOString(), title: first.subject },
      lastMeeting:
        last === undefined ? null : { start: last.start.toISOString(), title: last.subject },
      meetingHours: Math.round((meetingMs / 3_600_000) * 10) / 10,
      workingHours: WORKING_HOURS,
      longestFreeBlock:
        block === null
          ? null
          : { start: block.start.toISOString(), end: block.end.toISOString(), hours },
      note: freeTimeShort
        ? null
        : events.length === 0
          ? 'No meetings today, so no holds are needed.'
          : `The longest free block is ${String(hours)} hours, above the ${String(minFreeHours)} hour minimum, so no hold is proposed.`,
      calendarObservedAt,
    },
    freeTimeShort,
  };
}

/** Tasks due today or overdue across Notion and Jamie, newest observation per record, not done. */
type TaskSource = 'notion' | 'jamie';

/**
 * Whether one task observation belongs to the principal the brief is for
 * and still exists. The All Tasks DB holds every task in the company, so
 * the brief keeps the rows whose Assignee includes the principal's Notion
 * user; the Jamie watcher stamps its action items with `assignedToDom`
 * from the assignee's email. A page the Notion watcher recorded as removed
 * has left the database and is never a task. Dom is the only principal in
 * v1; the principal's identifiers come from config, never from this file.
 */
export function isPrincipalsLiveTask(
  source: TaskSource,
  payload: Record<string, unknown>,
  principalNotionUserId: string,
): boolean {
  if (payload['removed'] === true) return false;
  if (source === 'jamie') return payload['assignedToDom'] === true;
  const assignees = payload['assigneeIds'];
  return Array.isArray(assignees) && assignees.includes(principalNotionUserId);
}

function isTaskDone(source: TaskSource, payload: Record<string, unknown>): boolean {
  if (source === 'jamie') return payload['completed'] === true;
  return (TASK_CLOSED_STATUSES as readonly string[]).includes(str(payload['status']) ?? '');
}

/** The principal's Notion and Jamie tasks due today or earlier and not yet done (spec 10.1 item 3). */
export async function tasksDue(
  deps: BriefDataDeps,
  today: string,
): Promise<MorningBriefContent['tasks']> {
  const rows = await deps.db
    .selectDistinctOn([observations.sourceRecordId], OBSERVATION_COLUMNS)
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['notion', 'jamie']),
        sql`${observations.payload} ->> 'kind' = 'task'`,
      ),
    )
    .orderBy(...newestObservationFirst());
  const items: MorningBriefContent['tasks']['items'] = [];
  const todayMs = new Date(`${today}T00:00:00.000Z`).getTime();
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const source = row.sourceSystem as TaskSource;
    if (!isPrincipalsLiveTask(source, p, deps.config.notion.domUserId)) continue;
    if (isTaskDone(source, p)) continue;
    const due = (str(p['due']) ?? str(p['dueDate']))?.slice(0, 10) ?? null;
    if (due === null || due > today) continue;
    const dueMs = new Date(`${due}T00:00:00.000Z`).getTime();
    items.push({
      taskId: `${source}:${row.sourceRecordId}`,
      title: str(p['title']) ?? str(p['text']) ?? '(untitled)',
      source,
      reason: '',
      due,
      overdueDays: due < today ? Math.floor((todayMs - dueMs) / 86_400_000) : null,
      url: validUrl(p['url']),
    });
  }
  items.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  return { items, total: items.length, duplicatesMerged: 0 };
}

async function waitingFor(
  deps: BriefDataDeps,
  now: Date,
): Promise<MorningBriefContent['waitingFor']> {
  const rows = await deps.db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.direction, 'inbound'),
        inArray(commitments.status, ['open', 'chased']),
        sql`${commitments.nextChaseAt} <= ${now}`,
      ),
    );
  const out: MorningBriefContent['waitingFor'] = [];
  for (const row of rows) {
    const refs = (Array.isArray(row.sourceRefs) ? row.sourceRefs : []) as ProvenanceRef[];
    const provenance = refs[0];
    if (provenance === undefined) continue; // non-negotiable 5: nothing without provenance
    const organisation = await organisationOfPerson(deps, row.ownerPersonId, null);
    const chase = await deps.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.actionClass, 'draft_email'),
          inArray(proposals.status, ['pending', 'held', 'approved', 'edited']),
          sql`${proposals.payload} ->> 'commitmentId' = ${row.id}`,
        ),
      )
      .limit(1);
    out.push({
      commitmentId: row.id,
      description: row.description,
      counterparty: await personName(deps, row.ownerPersonId),
      organisation: organisation.name,
      dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
      overdueDays: overdueDays(row.dueAt, now.getTime()),
      chaseCount: row.chaseCount,
      chaseDueAt: row.nextChaseAt === null ? null : row.nextChaseAt.toISOString(),
      provenance,
      pendingChaseProposalId: chase[0]?.id ?? null,
    });
  }
  return out;
}

async function overnight(
  deps: BriefDataDeps,
  from: Date,
  to: Date,
): Promise<MorningBriefContent['overnight']> {
  const alertRows = await deps.db
    .select()
    .from(alerts)
    .where(and(gte(alerts.lastSeen, from), inArray(alerts.status, ['open', 'acked'])))
    .orderBy(desc(alerts.lastSeen));
  const pending = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.status, 'pending'))
    .orderBy(desc(proposals.createdAt));
  const executed = await deps.db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.status, 'executed'),
        eq(proposals.decidedBy, 'system:policy'),
        gte(proposals.updatedAt, from),
      ),
    )
    .orderBy(desc(proposals.updatedAt));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    alerts: alertRows.map((a) => ({
      alertId: a.id,
      severity: a.severity,
      title: a.title,
      at: a.lastSeen.toISOString(),
    })),
    awaiting: {
      count: pending.length,
      top: pending.slice(0, 3).map((p) => ({
        proposalId: p.id,
        preview: p.preview,
        actionClass: p.actionClass,
        expiresAt: p.expiresAt.toISOString(),
      })),
    },
    executed: executed.map((p) => ({ summary: p.preview, correlationId: p.correlationId })),
  };
}

async function agentHealth(
  deps: BriefDataDeps,
  now: Date,
  dayStart: Date,
): Promise<MorningBriefContent['agentHealth']> {
  const cursorRows = await deps.db.select().from(cursors);
  const byWatcher = new Map<string, Date>();
  for (const row of cursorRows) {
    if (row.key === '__started_at') continue;
    const prev = byWatcher.get(row.watcher);
    if (prev === undefined || row.updatedAt > prev) byWatcher.set(row.watcher, row.updatedAt);
  }
  const openBreakers = await deps.db
    .select({ dedupeKey: alerts.dedupeKey })
    .from(alerts)
    .where(and(eq(alerts.kind, 'breaker_open'), eq(alerts.status, 'open')));
  const brokenConnectors = new Set(
    openBreakers.map((row) => row.dedupeKey.replace(/^breaker:/, '')),
  );
  const watchers = [...byWatcher.entries()].map(([name, at]) => {
    const ageMinutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
    const connector = name.startsWith('graph') ? 'graph' : name;
    const state: MorningBriefContent['agentHealth']['watchers'][number]['state'] =
      brokenConnectors.has(connector) ? 'breaker_open' : ageMinutes > 120 ? 'stale' : 'healthy';
    return { name, ageMinutes, state };
  });
  const sumUsd = async (from: Date, to: Date): Promise<number> => {
    const rows = await deps.db
      .select({ total: sql<string>`coalesce(sum(${agentRuns.estimatedCostUsd}), 0)::text` })
      .from(agentRuns)
      .where(and(gte(agentRuns.startedAt, from), lt(agentRuns.startedAt, to)));
    return Number(rows[0]?.total ?? '0');
  };
  const gbp = (usd: number): number => Math.round(usd * deps.config.cost.usdToGbp * 100) / 100;
  return {
    watchers,
    breakersOpen: openBreakers.length,
    costYesterdayGbp: gbp(await sumUsd(addDays(dayStart, -1), dayStart)),
    costTodayGbp: gbp(await sumUsd(dayStart, now)),
    ceilingGbp: deps.config.cost.dailyCeilingGbp,
  };
}

function headlineOf(
  meetings: Meeting[],
  tasks: MorningBriefContent['tasks'],
  waiting: number,
): string {
  const external = meetings.filter((m) => m.audience === 'external').length;
  const overdue = tasks.items.filter((t) => t.overdueDays !== null).length;
  const parts = [
    meetings.length === 0
      ? 'No meetings.'
      : `${String(meetings.length)} meeting${meetings.length === 1 ? '' : 's'}${external === 0 ? '' : `, ${String(external)} external`}.`,
    overdue === 0 ? null : `${String(overdue)} task${overdue === 1 ? '' : 's'} overdue.`,
    waiting === 0 ? null : `${String(waiting)} waiting on others.`,
  ];
  return parts.filter((part): part is string => part !== null).join(' ');
}

export interface AssembledMorningBrief {
  content: MorningBriefContent;
  /** Whether the Planner should propose holds (spec 10.1 item 1). */
  freeTimeShort: boolean;
  events: CalendarEvent[];
}

export async function assembleMorningBrief(deps: BriefDataDeps): Promise<AssembledMorningBrief> {
  const now = new Date(deps.now());
  const zone = deps.config.timeZone;
  const dayStart = startOfLocalDay(now, zone);
  const dayEnd = addDays(dayStart, 1);
  const today = localDate(now, zone);

  const events = await calendarEvents(deps, dayStart, dayEnd);
  const meetings: Meeting[] = [];
  for (const event of events) meetings.push(await meetingOf(deps, event));
  const calendarObservedAt = events.reduce<Date>(
    (latest, event) => (event.row.ts > latest ? event.row.ts : latest),
    new Date(0),
  );
  const { shape, freeTimeShort } = dayShapeOf(
    events,
    dayStart,
    deps.config.briefs.minFreeBlockHours,
    (calendarObservedAt.getTime() === 0 ? now : calendarObservedAt).toISOString(),
  );
  const tasks = await tasksDue(deps, today);
  const waiting = await waitingFor(deps, now);
  const from = new Date(dayStart.getTime() - 5 * 3600 * 1000); // 19:00 the day before
  return {
    content: {
      date: today,
      headline: headlineOf(meetings, tasks, waiting.length),
      dayShape: { ...shape, proposedHolds: [] },
      meetings,
      tasks,
      waitingFor: waiting,
      overnight: await overnight(deps, from, now),
      agentHealth: await agentHealth(deps, now, dayStart),
    },
    freeTimeShort,
    events,
  };
}

/** What moved since the morning brief (spec 10.2). */
export async function assembleAfternoonBoard(
  deps: BriefDataDeps,
  since: Date,
): Promise<AfternoonBoardContent> {
  const now = new Date(deps.now());
  const zone = deps.config.timeZone;

  const taskRows = await deps.db
    .select(OBSERVATION_COLUMNS)
    .from(observations)
    .where(
      and(
        inArray(observations.sourceSystem, ['notion', 'jamie']),
        gte(observations.ts, since),
        sql`${observations.payload} ->> 'kind' = 'task'`,
      ),
    )
    .orderBy(desc(observations.ts));
  const tasksCompleted: AfternoonBoardContent['moved']['tasksCompleted'] = [];
  const seen = new Set<string>();
  for (const row of taskRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (seen.has(row.sourceRecordId)) continue;
    seen.add(row.sourceRecordId);
    const source = row.sourceSystem as TaskSource;
    if (!isPrincipalsLiveTask(source, p, deps.config.notion.domUserId)) continue;
    if (!isTaskDone(source, p)) continue;
    tasksCompleted.push({
      taskId: `${row.sourceSystem}:${row.sourceRecordId}`,
      title: str(p['title']) ?? str(p['text']) ?? '(untitled)',
      url: validUrl(p['url']),
    });
  }

  const decided = await deps.db
    .select({ status: proposals.status })
    .from(proposals)
    .where(gte(proposals.decidedAt, since));
  const proposalsDecided = {
    approved: decided.filter((p) => ['approved', 'executing', 'executed'].includes(p.status))
      .length,
    edited: decided.filter((p) => p.status === 'edited').length,
    rejected: decided.filter((p) => p.status === 'rejected').length,
  };
  const closed = await deps.db
    .select({ id: commitments.id, description: commitments.description })
    .from(commitments)
    .where(
      and(gte(commitments.updatedAt, since), inArray(commitments.status, ['done', 'dropped'])),
    );
  const pending = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.status, 'pending'))
    .orderBy(desc(proposals.createdAt));

  const tomorrowStart = addDays(startOfLocalDay(now, zone), 1);
  const tomorrow = (await calendarEvents(deps, tomorrowStart, addDays(tomorrowStart, 1)))[0];
  let tomorrowFirstMeeting: AfternoonBoardContent['tomorrowFirstMeeting'] = null;
  if (tomorrow !== undefined) {
    const meeting = await meetingOf(deps, tomorrow);
    const prep = await deps.db
      .select({ id: briefs.id })
      .from(briefs)
      .where(
        and(eq(briefs.kind, 'meeting_prep'), sql`${briefs.content} ->> 'eventId' = ${tomorrow.id}`),
      )
      .limit(1);
    tomorrowFirstMeeting = {
      title: meeting.title,
      start: meeting.start,
      audience: meeting.audience,
      counterpartyClass: meeting.counterpartyClass,
      attendees: meeting.attendees.map((a) => a.name),
      provenance: meeting.provenance,
      prepExists: prep.length > 0,
      prepBriefId: prep[0]?.id ?? null,
    };
  }

  return {
    since: since.toISOString(),
    moved: {
      tasksCompleted,
      proposalsDecided,
      commitmentsClosed: closed.map((c) => ({ commitmentId: c.id, description: c.description })),
    },
    pending: pending.map((p) => ({
      proposalId: p.id,
      preview: p.preview,
      expiresAt: p.expiresAt.toISOString(),
    })),
    tomorrowFirstMeeting,
  };
}
