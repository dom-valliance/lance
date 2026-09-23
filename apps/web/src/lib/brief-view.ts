import { londonDay } from '@/lib/ageing';
import type { AgeingEmphasis } from '@/components/ageing';
import type { ActionClass, CounterpartyClass, SourceSystem } from '@/lib/filters';
import { COUNTERPARTY_LABELS } from '@/lib/humanise';
import { formatTime } from '@/lib/time';

/**
 * The Today page's view model: the two brief contents mirrored by hand and
 * the pure functions that turn them into the words and geometry the page
 * renders.
 *
 * The web app cannot import `@lance/shared`, so the interfaces below are a
 * hand copy. `MorningBriefContentSchema` and `AfternoonBoardContentSchema`
 * in `packages/shared/src/briefs.ts` are the source of truth: change them
 * there first, then here. The api parses every brief against those schemas
 * before it answers, so the content arriving at this page is already valid.
 */

const LONDON = 'Europe/London';

/** External meetings expand to the full prep earlier than internal ones. */
export type Audience = 'external' | 'internal';

export interface ProvenanceRef {
  system: SourceSystem;
  recordId: string;
  hash: string;
  observedAt: string;
  url?: string;
}

export interface MeetingMarker {
  start: string;
  title: string;
}

export interface DayShape {
  firstMeeting: MeetingMarker | null;
  lastMeeting: MeetingMarker | null;
  meetingHours: number;
  workingHours: number;
  longestFreeBlock: { start: string; end: string; hours: number } | null;
  proposedHolds: { proposalId: string; title: string }[];
  note: string | null;
  calendarObservedAt: string;
}

export interface Interaction {
  kind: 'mail' | 'transcript' | 'meeting';
  at: string;
  summary: string;
  provenance: ProvenanceRef;
}

export interface Attendee {
  personId: string | null;
  name: string;
  role: string | null;
  organisation: string | null;
  email: string | null;
  unknown: boolean;
  interactions: Interaction[];
}

export interface MeetingCommitment {
  commitmentId: string;
  direction: 'outbound' | 'inbound';
  description: string;
  dueAt: string | null;
  overdueDays: number | null;
}

export interface MeetingDocument {
  title: string;
  source: string;
  editedAt: string | null;
  url: string | null;
}

export interface Meeting {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  audience: Audience;
  counterpartyClass: CounterpartyClass;
  provenance: ProvenanceRef;
  prepExpandsAt: string;
  attendees: Attendee[];
  commitments: MeetingCommitment[];
  documents: MeetingDocument[];
  objectives: string[];
}

export interface BriefTask {
  taskId: string;
  title: string;
  source: 'notion' | 'jamie';
  reason: string;
  due: string | null;
  overdueDays: number | null;
  url: string | null;
}

export interface WaitingFor {
  commitmentId: string;
  description: string;
  counterparty: string;
  organisation: string | null;
  dueAt: string | null;
  overdueDays: number | null;
  chaseCount: number;
  chaseDueAt: string | null;
  provenance: ProvenanceRef;
  pendingChaseProposalId: string | null;
}

export interface Overnight {
  from: string;
  to: string;
  alerts: { alertId: string; severity: 'P0' | 'P1' | 'P2'; title: string; at: string }[];
  awaiting: {
    count: number;
    top: { proposalId: string; preview: string; actionClass: ActionClass; expiresAt: string }[];
  };
  executed: { summary: string; correlationId: string }[];
}

export interface AgentHealth {
  watchers: {
    name: string;
    ageMinutes: number;
    state: 'healthy' | 'stale' | 'breaker_open' | 'paused';
  }[];
  breakersOpen: number;
  costYesterdayGbp: number;
  costTodayGbp: number;
  ceilingGbp: number;
}

export interface MorningBriefContent {
  date: string;
  headline: string;
  dayShape: DayShape;
  meetings: Meeting[];
  tasks: { items: BriefTask[]; total: number; duplicatesMerged: number };
  waitingFor: WaitingFor[];
  overnight: Overnight;
  agentHealth: AgentHealth;
}

export interface AfternoonBoardContent {
  since: string;
  moved: {
    tasksCompleted: { taskId: string; title: string; url: string | null }[];
    proposalsDecided: { approved: number; edited: number; rejected: number };
    commitmentsClosed: { commitmentId: string; description: string }[];
  };
  pending: { proposalId: string; preview: string; expiresAt: string }[];
  tomorrowFirstMeeting: {
    title: string;
    start: string;
    audience: Audience;
    counterpartyClass: CounterpartyClass;
    attendees: string[];
    provenance: ProvenanceRef;
    prepExists: boolean;
    prepBriefId: string | null;
  } | null;
}

/**
 * One row of `briefs` as `briefs.latest` answers it. The api validated
 * `content` against its kind's schema, but the procedure's return type
 * carries it as `unknown`, so the page narrows it through the two readers
 * below rather than parsing it a second time in the browser's bundle.
 */
export interface BriefRecord {
  id: string;
  kind: string;
  correlationId: string;
  /**
   * Optional because an `unknown` field admits `undefined`, so the tRPC
   * client types it as optional. The api has parsed it against its kind's
   * schema, so it is present for the two kinds this page reads.
   */
  content?: unknown;
  markdown: string;
  generatedAt: string;
}

export interface Brief<Content> {
  id: string;
  kind: string;
  correlationId: string;
  content: Content;
  markdown: string;
  generatedAt: string;
}

export type MorningBrief = Brief<MorningBriefContent>;
export type AfternoonBoard = Brief<AfternoonBoardContent>;

/* Regenerate --------------------------------------------------------------- */

/**
 * What the Regenerate action answers. `queued` remembers which brief was
 * on the page when the job went in, so the header knows the new one has
 * landed when the page's `generatedAt` differs from it.
 */
export type RegenerateState =
  | { status: 'idle' }
  | { status: 'queued'; at: string; previousGeneratedAt: string | null }
  | { status: 'failed'; message: string };

/** How long the header waits for a queued brief before it reports a failure. */
export const GENERATION_WAIT_MS = 3 * 60_000;

/**
 * True while a queued brief is still to come: the page still shows the
 * brief that was there when the job was queued and the header has not
 * given up waiting on this job.
 */
export function isGenerating(
  queued: { at: string; previousGeneratedAt: string | null },
  generatedAt: string | null,
  gaveUpAt: string | null,
): boolean {
  return queued.previousGeneratedAt === generatedAt && gaveUpAt !== queued.at;
}

export function asMorningBrief(record: BriefRecord | null): MorningBrief | null {
  if (record === null) return null;
  return { ...record, content: record.content as MorningBriefContent };
}

export function asAfternoonBoard(record: BriefRecord | null): AfternoonBoard | null {
  if (record === null) return null;
  return { ...record, content: record.content as AfternoonBoardContent };
}

/* Time of day in London ------------------------------------------------- */

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/**
 * Hours since midnight in London, fractional: 09:30 is 9.5. Every instant
 * is read in its own London day, which is what the day bar and the two
 * clock thresholds below need.
 */
export function londonHours(value: Date | string): number {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return read('hour') + read('minute') / 60;
}

/** The scheduler builds the morning brief at 06:30 London. */
const BRIEF_HOUR = 6.5;
/** The afternoon board appears at 16:00 London (spec 10.2). */
const BOARD_HOUR = 16;

/** True while the day's brief is still to come, which changes what the page says. */
export function isBeforeBriefTime(now: Date): boolean {
  return londonHours(now) < BRIEF_HOUR;
}

/** True from 16:00 London, when the afternoon board joins the page. */
export function isBoardTime(now: Date): boolean {
  return londonHours(now) >= BOARD_HOUR;
}

/**
 * The London day a brief describes: the morning brief states its own
 * `date`, the afternoon board carries the `since` instant it counts from.
 * A brief from any earlier day is not today's and is not rendered.
 */
export function isTodaysBrief(brief: { content?: unknown } | null, now: Date): boolean {
  if (brief === null) return false;
  const content = brief.content;
  if (typeof content !== 'object' || content === null) return false;
  if ('date' in content && typeof content.date === 'string') {
    return content.date === londonDay(now);
  }
  if ('since' in content && typeof content.since === 'string') {
    const since = new Date(content.since);
    return !Number.isNaN(since.getTime()) && londonDay(since) === londonDay(now);
  }
  return false;
}

/* The day bar ----------------------------------------------------------- */

/** The working window the day bar draws, 09:00 to 17:00 London. */
export const DAY_BAR_START_HOUR = 9;
export const DAY_BAR_END_HOUR = 17;
const DAY_BAR_HOURS = DAY_BAR_END_HOUR - DAY_BAR_START_HOUR;

/** The axis beneath the bar, every two hours. */
export const DAY_BAR_TICKS = ['09:00', '11:00', '13:00', '15:00', '17:00'] as const;

export interface DayBarSegment {
  id: string;
  title: string;
  audience: Audience;
  leftPercent: number;
  widthPercent: number;
}

export interface DayBar {
  segments: DayBarSegment[];
  /** Where the brand "now" line falls, or null when now is outside the window. */
  nowPercent: number | null;
}

const clampHour = (hours: number): number =>
  Math.min(Math.max(hours, DAY_BAR_START_HOUR), DAY_BAR_END_HOUR);

const asPercent = (hours: number): number =>
  Math.round(((hours - DAY_BAR_START_HOUR) / DAY_BAR_HOURS) * 10_000) / 100;

/**
 * Each meeting as a left and width percentage of the 09:00 to 17:00
 * window, clamped to it. A meeting with no overlap at all is left out of
 * the bar; it still appears in the meetings section below.
 */
export function dayBar(
  meetings: readonly Pick<Meeting, 'id' | 'title' | 'start' | 'end' | 'audience'>[],
  now: Date,
): DayBar {
  const segments: DayBarSegment[] = [];
  for (const meeting of meetings) {
    const start = londonHours(meeting.start);
    const end = londonHours(meeting.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const left = asPercent(clampHour(start));
    const right = asPercent(clampHour(end));
    if (right <= left) continue;
    segments.push({
      id: meeting.id,
      title: meeting.title,
      audience: meeting.audience,
      leftPercent: left,
      widthPercent: Math.round((right - left) * 100) / 100,
    });
  }
  const hours = londonHours(now);
  const inWindow = !Number.isNaN(hours) && hours >= DAY_BAR_START_HOUR && hours <= DAY_BAR_END_HOUR;
  return { segments, nowPercent: inWindow ? asPercent(hours) : null };
}

/* Words ----------------------------------------------------------------- */

/** "2 alerts", "1 alert": a count with its noun agreeing. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/** A number without a pointless trailing zero: 8 stays "8", 7.5 becomes "7.5". */
const trimNumber = (value: number): string => String(Math.round(value * 100) / 100);

/** "2 h 30", "8 h", "45 min": a span of hours in plain words. */
export function formatHours(hours: number): string {
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(whole)} h` : `${String(whole)} h ${String(rest).padStart(2, '0')}`;
}

/** "09:30, Halden Group", or "None" when the day has no meeting. */
export function meetingMarkerLabel(marker: MeetingMarker | null): string {
  return marker === null ? 'None' : `${formatTime(marker.start)}, ${marker.title}`;
}

/** "10:30 to 13:00, 2 h 30" in full, "10:30 to 13:00" without the length, "None" when the day is full. */
export function freeBlockLabel(
  block: DayShape['longestFreeBlock'],
  detail: 'with-length' | 'times-only',
): string {
  if (block === null) return 'None';
  const times = `${formatTime(block.start)} to ${formatTime(block.end)}`;
  return detail === 'with-length' ? `${times}, ${formatHours(block.hours)}` : times;
}

/** "2 h 30 of 8", the meeting load against the working day. */
export function meetingLoadLabel(meetingHours: number, workingHours: number): string {
  return `${formatHours(meetingHours)} of ${trimNumber(workingHours)}`;
}

/** "£4.12", always two decimals. */
export function formatGbp(value: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);
}

/** "19 Sept": the day and month, for a line that already sits in today's page. */
export function formatDayMonth(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: LONDON,
  }).format(date);
}

/** "External, client" or "Internal": who the meeting is with. */
export function audienceLabel(audience: Audience, counterpartyClass: CounterpartyClass): string {
  if (audience === 'internal') return 'Internal';
  return `External, ${COUNTERPARTY_LABELS[counterpartyClass].toLowerCase()}`;
}

const INTERACTION_LABELS: Record<Interaction['kind'], string> = {
  mail: 'Mail',
  transcript: 'Transcript',
  meeting: 'Meeting',
};

/** "Mail, 19 Sept": what the last contact was and when. */
export function interactionLabel(interaction: Pick<Interaction, 'kind' | 'at'>): string {
  return `${INTERACTION_LABELS[interaction.kind]}, ${formatDayMonth(interaction.at)}`;
}

/** "overdue by 3 days", "due today", "due 24 Sept": a commitment's standing. */
export function commitmentAgeing(
  dueAt: string | null,
  overdueDays: number | null,
): { label: string; emphasis: AgeingEmphasis } {
  if (overdueDays !== null && overdueDays > 0) {
    return { label: `overdue by ${countLabel(overdueDays, 'day')}`, emphasis: 'overdue' };
  }
  if (overdueDays === 0) return { label: 'due today', emphasis: 'soon' };
  if (dueAt === null) return { label: 'no date', emphasis: 'none' };
  return { label: `due ${formatDayMonth(dueAt)}`, emphasis: 'none' };
}

/** "not chased yet", "chased once", "chased twice", "chased 3 times". */
export function chaseLabel(chaseCount: number): string {
  if (chaseCount <= 0) return 'not chased yet';
  if (chaseCount === 1) return 'chased once';
  if (chaseCount === 2) return 'chased twice';
  return `chased ${String(chaseCount)} times`;
}

/** "Marcus Reid, Ostrava Partners" or the person alone when no organisation is known. */
export function counterpartyLabel(counterparty: string, organisation: string | null): string {
  return organisation === null || organisation === ''
    ? counterparty
    : `${counterparty}, ${organisation}`;
}

/** "Marcus Reid and Lena Vogt", "Marcus Reid, Lena Vogt and Ana Rees". */
export function listSentence(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

/** An hour or less to decide, which the board marks in the brand colour. */
const SOON_MS = 60 * 60 * 1000;

export function expiresSoon(expiresAt: string, now: Date): boolean {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() - now.getTime() <= SOON_MS;
}

/** "12 due or overdue in total, 2 duplicates merged across Notion and Jamie." */
export function tasksFooter(total: number, duplicatesMerged: number): string {
  return `${String(total)} due or overdue in total, ${countLabel(duplicatesMerged, 'duplicate')} merged across Notion and Jamie.`;
}

/** "19:00 yesterday to 06:30": the window the overnight section covers. */
export function overnightWindowLabel(from: string, to: string): string {
  const fromDate = new Date(from);
  const toDate_ = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate_.getTime())) {
    return 'overnight';
  }
  const time = (value: Date): string =>
    new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: LONDON }).format(value);
  const sameDay = londonDay(fromDate) === londonDay(toDate_);
  return `${time(fromDate)}${sameDay ? '' : ' yesterday'} to ${time(toDate_)}`;
}

/** "All breakers closed." or "2 breakers open." */
export function breakersLabel(breakersOpen: number): string {
  if (breakersOpen === 0) return 'All breakers closed.';
  return `${countLabel(breakersOpen, 'breaker')} open.`;
}

/** "Yesterday cost £4.12 of the £15.00 ceiling; today so far £2.87." */
export function costLine(
  health: Pick<AgentHealth, 'costYesterdayGbp' | 'costTodayGbp' | 'ceilingGbp'>,
): string {
  return `Yesterday cost ${formatGbp(health.costYesterdayGbp)} of the ${formatGbp(health.ceilingGbp)} ceiling; today so far ${formatGbp(health.costTodayGbp)}.`;
}

/** "3 proposals decided: 2 approved, 1 rejected." with the zero counts left out. */
export function decidedLabel(decided: {
  approved: number;
  edited: number;
  rejected: number;
}): string {
  const total = decided.approved + decided.edited + decided.rejected;
  const parts = [
    { count: decided.approved, word: 'approved' },
    { count: decided.edited, word: 'edited' },
    { count: decided.rejected, word: 'rejected' },
  ]
    .filter((part) => part.count > 0)
    .map((part) => `${String(part.count)} ${part.word}`);
  const head = `${countLabel(total, 'proposal')} decided`;
  return parts.length === 0 ? `${head}.` : `${head}: ${parts.join(', ')}.`;
}

/**
 * The summary when today has no brief and the build time has passed:
 * "No brief. Last successful brief yesterday, 06:30.", with the date
 * instead of "yesterday" for an older one, and a plain "No brief yet."
 * when none has ever been generated.
 */
export function noBriefSummary(lastGeneratedAt: string | null, now: Date): string {
  if (lastGeneratedAt === null) return 'No brief yet.';
  const date = new Date(lastGeneratedAt);
  if (Number.isNaN(date.getTime())) return 'No brief yet.';
  const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: LONDON }).format(
    date,
  );
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const day = londonDay(date) === londonDay(yesterday) ? 'yesterday' : formatDayMonth(date);
  return `No brief. Last successful brief ${day}, ${time}.`;
}

/** "Brief generated 06:30 today", or the date as well when the brief is older. */
export function generatedLabel(generatedAt: string, now: Date): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return 'Brief generation time unknown';
  const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: LONDON }).format(
    date,
  );
  if (londonDay(date) === londonDay(now)) return `Brief generated ${time} today`;
  return `Brief generated ${formatDayMonth(date)}, ${time}`;
}

/* Meetings -------------------------------------------------------------- */

/** True once the meeting's prep has expanded (30 minutes before an external one). */
export function isPrepExpanded(meeting: Pick<Meeting, 'prepExpandsAt'>, now: Date): boolean {
  const at = new Date(meeting.prepExpandsAt);
  return !Number.isNaN(at.getTime()) && now.getTime() >= at.getTime();
}

/** The id of the first meeting that has not finished, which the phone layout expands. */
export function nextMeetingId(
  meetings: readonly Pick<Meeting, 'id' | 'end'>[],
  now: Date,
): string | null {
  for (const meeting of meetings) {
    const end = new Date(meeting.end);
    if (!Number.isNaN(end.getTime()) && end.getTime() > now.getTime()) return meeting.id;
  }
  return null;
}

/**
 * Where a meeting's prep is shown. The desktop layout expands on the
 * prep clock; the phone layout expands the next meeting only, so one
 * meeting can be open at one width and summarised at the other.
 */
export type Visibility = 'both' | 'desktop' | 'phone' | 'none';

export function meetingVisibility(expanded: boolean, next: boolean): Visibility {
  if (expanded && next) return 'both';
  if (expanded) return 'desktop';
  if (next) return 'phone';
  return 'none';
}

/** The summary line shows exactly where the prep does not. */
export function invertVisibility(visibility: Visibility): Visibility {
  if (visibility === 'both') return 'none';
  if (visibility === 'none') return 'both';
  return visibility === 'desktop' ? 'phone' : 'desktop';
}
