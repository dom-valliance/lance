import type { SlackSurface } from '@lance/connectors';
import type { Alert, Commitment } from '@lance/db';
import type {
  DecisionResult,
  CostCeiling,
  RaiseAlertInput,
  RaiseAlertResult,
  InterruptionBudget,
  LedgerCountQuery,
  LedgerEventRow,
  LedgerQuery,
  PauseResult,
  PendingProposalSummary,
  ProposalCountFilter,
  ProposalFilter,
  ResumeResult,
  RunState,
} from '@lance/ledger';
import {
  loadConfig,
  newUlid,
  type Config,
  type LanceRole,
  type LedgerEventInputCandidate,
  type Proposal,
  type SystemMode,
} from '@lance/shared';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type {
  AdminPrincipalView,
  AdminStoreLike,
  OffboardingQueued,
  OffboardingRequest,
  RuleChangeView,
  SystemAlertView,
  ApiDeps,
  Caller,
  GraphConsentDeps,
  JamieKeyDeps,
  SlackLinkIssue,
  SlackLinkOutcome,
  SlackLinkPreview,
  SlackLinksLike,
  SlackLinkState,
  LedgerReaderLike,
  PrincipalDirectoryLike,
  PrincipalHealth,
  PrincipalRef,
  ServerDeps,
  VerifiedIdentity,
  LedgerWriterLike,
  OntologyLike,
  OntologyNodeLike,
  ProposalStoreLike,
  SystemControlLike,
  TokenVerifier,
} from './deps.js';
import type { AgentLastRun, AgentRunRow, AgentsStoreLike, CursorRow } from './agents/store.js';
import type {
  AlertCountQuery,
  AlertQuery,
  AlertStoreLike,
  SetAlertStatusInput,
} from './alerts/store.js';
import type { BriefQuery, BriefRecord, BriefStoreLike, LatestBriefQuery } from './briefs/store.js';
import type {
  CommitmentCountQuery,
  CommitmentQuery,
  CommitmentStoreLike,
  CommitmentSummary,
  CommitmentTally,
} from './commitments/store.js';
import type { TaskCountQuery, TaskQuery, TaskStoreLike } from './tasks/store.js';
import { toTaskView, type ObservationRecord } from './tasks/view.js';
import { onboardingProgress } from './admin/onboarding.js';
import type {
  ClaimedConsent,
  ConsentPrincipal,
  ConsentStateStoreLike,
} from './auth/graph-state.js';
import { BadRequestError, UnauthorisedError } from './errors.js';
import { createFeed, type Feed, type FeedEvent } from './events.js';
import type { JobListing, JobsServiceLike, JobToggleStatus } from './jobs/service.js';
import type {
  CompletionResult,
  OnboardingServiceLike,
  OnboardingState,
  PreferencesInput,
} from './onboarding/service.js';
import type { DecisionRequest } from './proposals/decide.js';
import type { StatusSnapshot, StatusSource } from './status.js';
import type { ApiContext } from './trpc.js';

/**
 * Fakes and builders for the test suite. Not exported from the package
 * entry point and never imported by a route: the api ships the real
 * collaborators and tests inject these.
 */

export const TEST_UPN = 'dom@valliance.ai';
export const TEST_SIGNING_SECRET = 'slack-signing-secret-for-tests';
export const TEST_INGEST_SECRET = 'ingest-secret-for-tests';
export const TEST_SLACK_USER_ID = 'U0DOM';
export const TEST_SLACK_TEAM_ID = 'T0VALLIANCE';
/** Dom's channel, `dom-claude-agent`, the config default. */
export const TEST_CHANNEL_ID = 'C0BU7P278N5';
/** The seed principal's id, `SEED_PRINCIPAL_ID` in `@lance/db`. */
export const TEST_PRINCIPAL_ID = '01K5S9V6QW3SWCCPVB0N0E300H';
export const TEST_OID = '19fb2afd-6814-4600-8697-eb798ec5691f';
/** The notice hash the fake server carries. */
export const TEST_NOTICE_SHA256 = 'a'.repeat(64);

export const fakePrincipal = (overrides: Partial<PrincipalRef> = {}): PrincipalRef => ({
  id: TEST_PRINCIPAL_ID,
  upn: TEST_UPN,
  status: 'active',
  slackUserId: TEST_SLACK_USER_ID,
  slackChannelId: TEST_CHANNEL_ID,
  lanceRoles: ['Lance.User', 'Lance.Admin'],
  createdAt: new Date('2026-09-20T09:00:00.000Z'),
  ...overrides,
});

export const fakeIdentity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  oid: TEST_OID,
  upn: TEST_UPN,
  roles: ['Lance.User'],
  ...overrides,
});

export const testConfig = (env: NodeJS.ProcessEnv = {}): Config =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
    ...env,
  });

export const fakeSystemState = (overrides: Partial<RunState> = {}): RunState => ({
  principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
  paused: false,
  pausedGlobally: false,
  pausedReason: null,
  pausedBy: null,
  pausedAt: null,
  mode: 'dry_run',
  quietHoursStart: '19:00',
  quietHoursEnd: '07:00',
  pushBudgetPerHour: 3,
  costCeilingGbp: 15,
  updatedAt: new Date('2026-09-20T09:00:00.000Z'),
  ...overrides,
});

export const fakeSnapshot = (overrides: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  at: '2026-09-20T09:00:00.000Z',
  paused: false,
  pausedReason: null,
  pausedBy: null,
  pausedAt: null,
  mode: 'dry_run',
  cursors: [
    {
      watcher: 'graph-mail',
      key: 'inbox',
      value: 'delta-token',
      updatedAt: '2026-09-20T08:48:00.000Z',
      ageMinutes: 12,
    },
  ],
  costTodayGbp: 1.234,
  ...overrides,
});

export class FakeSystemControl implements SystemControlLike {
  state: RunState = fakeSystemState();
  readonly pauseCalls: { reason: string; actor: string }[] = [];
  readonly resumeCalls: { actor: string }[] = [];
  readFails = false;

  read(): Promise<RunState> {
    if (this.readFails) {
      return Promise.reject(new Error('connection refused'));
    }
    return Promise.resolve(this.state);
  }

  pause(options: { reason: string; actor: string }): Promise<PauseResult> {
    this.pauseCalls.push(options);
    const changed = !this.state.paused;
    this.state = fakeSystemState({
      paused: true,
      pausedReason: options.reason,
      pausedBy: options.actor,
    });
    return Promise.resolve({
      changed,
      heldProposalIds: ['01K5S9V6QW3SWCCPVB0N0E301A'],
      eventId: '01K5S9V6QW3SWCCPVB0N0E30E1',
    });
  }

  readonly modeCalls: { mode: SystemMode; actor: string }[] = [];
  /** Set to refuse the next switch to live, as SystemControl does inside a new principal's dry run. */
  refuseLive: Error | null = null;

  setMode(
    mode: SystemMode,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }> {
    if (mode === 'live' && this.refuseLive !== null) return Promise.reject(this.refuseLive);
    this.modeCalls.push({ mode, actor: options.actor });
    const changed = this.state.mode !== mode;
    this.state = { ...this.state, mode };
    return Promise.resolve({ changed, eventId: '01K5S9V6QW3SWCCPVB0N0E30E3' });
  }

  readonly budgetCalls: { budget: InterruptionBudget; actor: string }[] = [];

  readonly ceilingCalls: { ceiling: CostCeiling; actor: string }[] = [];

  setCostCeiling(
    ceiling: CostCeiling,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }> {
    this.ceilingCalls.push({ ceiling, actor: options.actor });
    const changed = this.state.costCeilingGbp !== ceiling.costCeilingGbp;
    this.state = { ...this.state, costCeilingGbp: ceiling.costCeilingGbp };
    return Promise.resolve({ changed, eventId: '01K5S9V6QW3SWCCPVB0N0E30E5' });
  }

  setInterruptionBudget(
    budget: InterruptionBudget,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }> {
    this.budgetCalls.push({ budget, actor: options.actor });
    const changed =
      this.state.quietHoursStart !== budget.quietHoursStart ||
      this.state.quietHoursEnd !== budget.quietHoursEnd ||
      this.state.pushBudgetPerHour !== budget.pushBudgetPerHour;
    this.state = { ...this.state, ...budget };
    return Promise.resolve({ changed, eventId: '01K5S9V6QW3SWCCPVB0N0E30E4' });
  }

  readonly pauseAllCalls: { reason: string; actor: string }[] = [];
  readonly resumeAllCalls: { actor: string }[] = [];

  pauseAll(options: { reason: string; actor: string }): Promise<PauseResult> {
    this.pauseAllCalls.push(options);
    const changed = !this.state.pausedGlobally;
    this.state = { ...this.state, paused: true, pausedGlobally: true };
    return Promise.resolve({
      changed,
      heldProposalIds: [],
      eventId: '01K5S9V6QW3SWCCPVB0N0E30E6',
    });
  }

  resumeAll(options: { actor: string }): Promise<{ changed: boolean; eventId: string }> {
    this.resumeAllCalls.push(options);
    const changed = this.state.pausedGlobally;
    this.state = { ...this.state, pausedGlobally: false };
    return Promise.resolve({ changed, eventId: '01K5S9V6QW3SWCCPVB0N0E30E7' });
  }

  organisationCeilingGbp = 30;

  readOrganisation(): Promise<{ paused: boolean; costCeilingGbp: number }> {
    return Promise.resolve({
      paused: this.state.pausedGlobally,
      costCeilingGbp: this.organisationCeilingGbp,
    });
  }

  readonly organisationCeilingCalls: { costCeilingGbp: number; actor: string }[] = [];

  setOrganisationCostCeiling(
    ceiling: CostCeiling,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }> {
    this.organisationCeilingCalls.push({
      costCeilingGbp: ceiling.costCeilingGbp,
      actor: options.actor,
    });
    const changed = this.organisationCeilingGbp !== ceiling.costCeilingGbp;
    this.organisationCeilingGbp = ceiling.costCeilingGbp;
    return Promise.resolve({ changed, eventId: '01K5S9V6QW3SWCCPVB0N0E30E8' });
  }

  resume(options: { actor: string }): Promise<ResumeResult> {
    this.resumeCalls.push(options);
    const changed = this.state.paused;
    this.state = fakeSystemState({ paused: false });
    return Promise.resolve({
      changed,
      releasedProposalIds: ['01K5S9V6QW3SWCCPVB0N0E301A'],
      eventId: '01K5S9V6QW3SWCCPVB0N0E30E2',
    });
  }
}

/** The caller's job rows without a database; `setEnabled` follows JobControl's rules. */
export class FakeJobs implements JobsServiceLike {
  jobs: JobListing[] = [
    { slug: 'alerts-deliver', enabled: true, locked: true, nextRunAt: '2026-09-20T09:01:00.000Z' },
    { slug: 'brief-morning', enabled: true, locked: false, nextRunAt: '2026-09-21T05:30:00.000Z' },
  ];
  readonly toggles: { slug: string; enabled: boolean; actor: string }[] = [];

  list(): Promise<JobListing[]> {
    return Promise.resolve(this.jobs);
  }

  setEnabled(slug: string, enabled: boolean, actor: string): Promise<JobToggleStatus> {
    this.toggles.push({ slug, enabled, actor });
    const job = this.jobs.find((candidate) => candidate.slug === slug);
    if (job === undefined) return Promise.resolve('unknown');
    if (job.locked && !enabled) return Promise.resolve('locked');
    if (job.enabled === enabled) return Promise.resolve('unchanged');
    job.enabled = enabled;
    job.nextRunAt = enabled ? '2026-09-21T05:30:00.000Z' : null;
    return Promise.resolve('changed');
  }
}

export class FakeLedgerReader implements LedgerReaderLike {
  rows: LedgerEventRow[] = [];
  readonly queries: (LedgerQuery | undefined)[] = [];
  readonly counts: (LedgerCountQuery | undefined)[] = [];

  /**
   * Returns the rows as set, which a test lists newest first, continuing
   * after the `after` row and cut to the limit. The filters are recorded
   * rather than applied.
   */
  query(filter?: LedgerQuery): Promise<LedgerEventRow[]> {
    this.queries.push(filter);
    const after = filter?.after;
    const start = after === undefined ? 0 : this.rows.findIndex((row) => row.id === after) + 1;
    return Promise.resolve(this.rows.slice(start).slice(0, filter?.limit));
  }

  get(id: string): Promise<LedgerEventRow | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  count(filter?: LedgerCountQuery): Promise<number> {
    this.counts.push(filter);
    return Promise.resolve(this.rows.length);
  }

  byCorrelation(correlationId: string): Promise<LedgerEventRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.correlationId === correlationId));
  }
}

export class FakeLedgerWriter implements LedgerWriterLike {
  readonly appended: LedgerEventInputCandidate[] = [];

  append(candidate: LedgerEventInputCandidate): Promise<{ id: string; inserted: boolean }> {
    this.appended.push(candidate);
    return Promise.resolve({ id: newUlid(), inserted: true });
  }
}

export const fakeProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: '01K5S9V6QW3SWCCPVB0N0E301A',
  correlationId: '01K5S9V6QW3SWCCPVB0N0E301B',
  actionClass: 'draft_email',
  counterpartyClass: 'client',
  targetSystem: 'graph',
  targetRecordId: 'AAMk1',
  reversibility: 'compensatable',
  payload: { subject: 'Re: the pilot', bodyText: 'Thanks, Tuesday works.' },
  preview: 'Reply to "the pilot"',
  rationale: 'They asked for a date and Tuesday is free.',
  provenance: [
    { system: 'graph', recordId: 'AAMk1', hash: 'h1', observedAt: '2026-09-20T09:00:00.000Z' },
  ],
  policyDecision: 'propose',
  policyRuleId: null,
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  editedPayload: null,
  slackChannel: null,
  slackTs: null,
  expiresAt: '2026-09-22T09:00:00.000Z',
  executionEventId: null,
  ...overrides,
});

/** The proposals table without a database: filters, cursors and the page limit. */
export class FakeProposalStore implements ProposalStoreLike {
  rows: Proposal[] = [fakeProposal()];
  readonly filters: (ProposalFilter | undefined)[] = [];
  readonly counts: (ProposalCountFilter | undefined)[] = [];

  private matching(query: ProposalCountFilter): Proposal[] {
    return this.rows
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => query.actionClass === undefined || row.actionClass === query.actionClass)
      .filter(
        (row) =>
          query.counterpartyClass === undefined ||
          row.counterpartyClass === query.counterpartyClass,
      )
      .filter((row) => query.targetSystem === undefined || row.targetSystem === query.targetSystem);
  }

  list(filter?: ProposalFilter): Promise<Proposal[]> {
    this.filters.push(filter);
    const query = filter ?? {};
    const matched = this.matching(query)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(query.limit === undefined ? matched : matched.slice(0, query.limit));
  }

  count(filter?: ProposalCountFilter): Promise<number> {
    this.counts.push(filter);
    return Promise.resolve(this.matching(filter ?? {}).length);
  }

  summary(): Promise<PendingProposalSummary> {
    const expiries = this.matching({ status: 'pending' })
      .map((row) => row.expiresAt)
      .sort();
    return Promise.resolve({ pending: expiries.length, oldestExpiresAt: expiries[0] ?? null });
  }

  get(id: string): Promise<Proposal | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }
}

export const TEST_COMMITMENT_ID = '01K5S9V6QW3SWCCPVB0N0E302A';
export const TEST_PERSON_ID = 'per-ann';

export const fakeCommitment = (overrides: Partial<Commitment> = {}): Commitment => ({
  principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
  id: TEST_COMMITMENT_ID,
  direction: 'inbound',
  // The recorder puts the other party in both columns for an inbound
  // commitment: they own it, and they are the counterparty.
  ownerPersonId: TEST_PERSON_ID,
  counterpartyPersonId: TEST_PERSON_ID,
  description: 'Send the signed order form',
  dueAt: new Date('2026-09-18T17:00:00.000Z'),
  dueConfidence: 0.8,
  evidenceQuote: 'I will get the order form over to you by Friday',
  sourceRefs: [
    { system: 'graph', recordId: 'AAMk2', hash: 'h2', observedAt: '2026-09-14T09:00:00.000Z' },
  ],
  status: 'open',
  chaseCount: 0,
  nextChaseAt: new Date('2026-09-20T17:00:00.000Z'),
  createdAt: new Date('2026-09-14T09:00:00.000Z'),
  updatedAt: new Date('2026-09-14T09:00:00.000Z'),
  ...overrides,
});

/** The commitments table without a database: filters, cursors and one status write. */
export class FakeCommitmentStore implements CommitmentStoreLike {
  rows: Commitment[] = [fakeCommitment()];
  readonly queries: CommitmentQuery[] = [];
  readonly counts: CommitmentCountQuery[] = [];

  private matching(query: CommitmentCountQuery): Commitment[] {
    return this.rows
      .filter((row) => query.direction === undefined || row.direction === query.direction)
      .filter((row) => query.status === undefined || row.status === query.status);
  }

  list(query: CommitmentQuery): Promise<Commitment[]> {
    this.queries.push(query);
    const matched = this.matching(query)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(matched.slice(0, query.limit));
  }

  count(query: CommitmentCountQuery): Promise<number> {
    this.counts.push(query);
    return Promise.resolve(this.matching(query).length);
  }

  summary(now: Date): Promise<CommitmentSummary> {
    const tally = (direction: Commitment['direction']): CommitmentTally => {
      const open = this.matching({ direction, status: 'open' });
      const overdue = open.filter((row) => row.dueAt !== null && row.dueAt < now);
      return { open: open.length, overdue: overdue.length };
    };
    return Promise.resolve({ inbound: tally('inbound'), outbound: tally('outbound') });
  }

  get(id: string): Promise<Commitment | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  setStatus(input: {
    id: string;
    from: Commitment['status'][];
    to: Commitment['status'];
    at: Date;
  }): Promise<Commitment | null> {
    const index = this.rows.findIndex(
      (row) => row.id === input.id && input.from.includes(row.status),
    );
    if (index === -1) return Promise.resolve(null);
    const updated = { ...this.rows[index]!, status: input.to, updatedAt: input.at };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
}

export const TEST_ALERT_ID = '01K5S9V6QW3SWCCPVB0N0E304A';

export const fakeAlert = (overrides: Partial<Alert> = {}): Alert => ({
  principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
  id: TEST_ALERT_ID,
  severity: 'P1',
  kind: 'client_mail_unanswered',
  dedupeKey: 'thread:AAMk3',
  title: 'No reply to Ann Example in three working days',
  body: 'The thread "the pilot" has had no reply since Tuesday.',
  provenance: [
    { system: 'graph', recordId: 'AAMk3', hash: 'h3', observedAt: '2026-09-20T09:00:00.000Z' },
  ],
  status: 'open',
  firstSeen: new Date('2026-09-20T09:00:00.000Z'),
  lastSeen: new Date('2026-09-21T09:00:00.000Z'),
  count: 2,
  ackedBy: null,
  ackedAt: null,
  mutedUntil: null,
  slackTs: null,
  batchTs: null,
  createdAt: new Date('2026-09-20T09:00:00.000Z'),
  updatedAt: new Date('2026-09-21T09:00:00.000Z'),
  ...overrides,
});

/** The alerts table without a database: filters, cursors and one status write. */
export class FakeAlertStore implements AlertStoreLike {
  rows: Alert[] = [fakeAlert()];
  readonly queries: AlertQuery[] = [];
  readonly counts: AlertCountQuery[] = [];

  private matching(query: AlertCountQuery): Alert[] {
    return this.rows
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => query.severity === undefined || row.severity === query.severity)
      .filter((row) => query.kind === undefined || row.kind === query.kind);
  }

  list(query: AlertQuery): Promise<Alert[]> {
    this.queries.push(query);
    const matched = this.matching(query)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(matched.slice(0, query.limit));
  }

  count(query: AlertCountQuery): Promise<number> {
    this.counts.push(query);
    return Promise.resolve(this.matching(query).length);
  }

  get(id: string): Promise<Alert | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  setStatus(input: SetAlertStatusInput): Promise<Alert | null> {
    const index = this.rows.findIndex(
      (row) => row.id === input.id && input.from.includes(row.status),
    );
    if (index === -1) return Promise.resolve(null);
    const updated: Alert = {
      ...this.rows[index]!,
      status: input.to,
      updatedAt: input.at,
      ...(input.ackedBy === undefined ? {} : { ackedBy: input.ackedBy, ackedAt: input.at }),
      ...(input.mutedUntil === undefined ? {} : { mutedUntil: input.mutedUntil }),
    };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
}

export const fakeNotionTaskObservation = (
  overrides: Partial<ObservationRecord> = {},
): ObservationRecord => ({
  id: '01K5S9V6QW3SWCCPVB0N0E303A',
  ts: new Date('2026-09-20T08:00:00.000Z'),
  sourceSystem: 'notion',
  sourceRecordId: '20257534-6e48-81fe-b4b5-000b69ecace7',
  payload: {
    kind: 'task',
    id: '20257534-6e48-81fe-b4b5-000b69ecace7',
    url: 'https://www.notion.so/20257534',
    title: 'Draft the pilot scope',
    status: 'In Progress',
    assigneeIds: ['1fdd872b-594c-8146-b22f-00028f1f5a41'],
    due: '2026-09-25',
  },
  ...overrides,
});

/** The observations table's task rows without a database. */
export class FakeTaskStore implements TaskStoreLike {
  rows: ObservationRecord[] = [fakeNotionTaskObservation()];
  notionUserId: string | null = '1fdd872b-594c-8146-b22f-00028f1f5a41';
  readonly queries: TaskQuery[] = [];
  readonly counts: TaskCountQuery[] = [];

  private matching(query: TaskCountQuery): ObservationRecord[] {
    const options = { principalNotionUserId: this.notionUserId };
    return this.rows
      .filter((row) => query.source === undefined || row.sourceSystem === query.source)
      .filter((row) => {
        if (query.status === undefined) return true;
        const view = toTaskView(row, options);
        return view !== null && view.done === (query.status === 'done');
      });
  }

  list(query: TaskQuery): Promise<ObservationRecord[]> {
    this.queries.push(query);
    const matched = this.matching(query)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(matched.slice(0, query.limit));
  }

  count(query: TaskCountQuery): Promise<number> {
    this.counts.push(query);
    return Promise.resolve(this.matching(query).length);
  }

  principalNotionUserId(): Promise<string | null> {
    return Promise.resolve(this.notionUserId);
  }
}

export const fakeBrief = (overrides: Partial<BriefRecord> = {}): BriefRecord => ({
  id: '01K5S9V6QW3SWCCPVB0N0E305A',
  kind: 'morning_brief',
  correlationId: '01K5S9V6QW3SWCCPVB0N0E305B',
  content: {},
  markdown: '# Morning brief',
  generatedAt: '2026-09-22T05:30:00.000Z',
  ...overrides,
});

/** The briefs table without a database: one local day, a page, or one row. */
export class FakeBriefStore implements BriefStoreLike {
  rows: BriefRecord[] = [];
  readonly latestQueries: LatestBriefQuery[] = [];

  latest(query: LatestBriefQuery): Promise<BriefRecord | null> {
    this.latestQueries.push(query);
    const matched = [...this.rows]
      .filter((row) => row.kind === query.kind)
      .filter((row) => {
        const at = new Date(row.generatedAt);
        return at >= query.from && at < query.to;
      })
      .sort((left, right) =>
        left.generatedAt === right.generatedAt
          ? right.id.localeCompare(left.id)
          : right.generatedAt.localeCompare(left.generatedAt),
      );
    return Promise.resolve(matched[0] ?? null);
  }

  list(query: BriefQuery): Promise<BriefRecord[]> {
    const matched = [...this.rows]
      .filter((row) => query.kind === undefined || row.kind === query.kind)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => right.id.localeCompare(left.id));
    return Promise.resolve(matched.slice(0, query.limit));
  }

  get(id: string): Promise<BriefRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }
}

export const fakeCursorRow = (overrides: Partial<CursorRow> = {}): CursorRow => ({
  watcher: 'graph-mail',
  key: 'inbox',
  value: 'delta-token',
  updatedAt: new Date('2026-09-22T08:48:00.000Z'),
  ...overrides,
});

export const fakeAgentRun = (overrides: Partial<AgentRunRow> = {}): AgentRunRow => ({
  agent: 'triage',
  startedAt: new Date('2026-09-22T08:00:00.000Z'),
  status: 'succeeded',
  costUsd: 0.1,
  error: null,
  ...overrides,
});

/**
 * The cursors, agent runs and pushes behind the Agents page, without a
 * database. `lastRuns` is derived from `runs`, as the distinct-on query is.
 */
export class FakeAgentsStore implements AgentsStoreLike {
  cursorRows: CursorRow[] = [fakeCursorRow()];
  runs: AgentRunRow[] = [fakeAgentRun()];
  pushes = 0;
  /** The `since` of every push count asked for, in order. */
  readonly pushWindows: Date[] = [];

  listCursors(): Promise<CursorRow[]> {
    return Promise.resolve(
      [...this.cursorRows].sort(
        (left, right) =>
          left.watcher.localeCompare(right.watcher) || left.key.localeCompare(right.key),
      ),
    );
  }

  runsSince(since: Date): Promise<AgentRunRow[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => run.startedAt >= since)
        .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime()),
    );
  }

  lastRuns(): Promise<AgentLastRun[]> {
    const newest = new Map<string, AgentRunRow>();
    for (const run of this.runs) {
      const seen = newest.get(run.agent);
      if (seen === undefined || run.startedAt > seen.startedAt) newest.set(run.agent, run);
    }
    return Promise.resolve(
      [...newest.values()].map((run) => ({
        agent: run.agent,
        startedAt: run.startedAt,
        error: run.error,
      })),
    );
  }

  pushesSince(since: Date): Promise<number> {
    this.pushWindows.push(since);
    return Promise.resolve(this.pushes);
  }
}

/** Person nodes keyed by id; an id it does not hold reads as a missing node. */
export class FakeOntology implements OntologyLike {
  readonly nodes = new Map<string, OntologyNodeLike>([
    [TEST_PERSON_ID, { properties: { display_name: 'Ann Example', emails: ['ann@client.test'] } }],
  ]);

  getNode(id: string): Promise<OntologyNodeLike | null> {
    return Promise.resolve(this.nodes.get(id) ?? null);
  }
}

/** Records every decision the routes ask for, without a state machine behind it. */
export class FakeDecider {
  readonly requests: DecisionRequest[] = [];
  result: DecisionResult = {
    proposalId: '01K5S9V6QW3SWCCPVB0N0E301A',
    from: 'pending',
    to: 'approved',
    execute: true,
    eventId: '01K5S9V6QW3SWCCPVB0N0E301C',
  };
  /** Set to make the next decision fail, as a refused transition would. */
  failWith: Error | null = null;

  decide(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve({ ...this.result, proposalId: request.proposalId });
  }
}

export interface FakeSlackSurface {
  surface: SlackSurface;
  updates: { ts: string; text: string }[];
  views: { triggerId: string; view: unknown }[];
}

/** The Slack surface with every call recorded and nothing sent. */
export const fakeSlackSurface = (channelId = 'C0BU7P278N5'): FakeSlackSurface => {
  const updates: { ts: string; text: string }[] = [];
  const views: { triggerId: string; view: unknown }[] = [];
  const surface: SlackSurface = {
    channelId,
    connector: {} as SlackSurface['connector'],
    post: (input) => {
      void input;
      return Promise.resolve({ channel: channelId, ts: '1758351600.000100' });
    },
    update: (input) => {
      updates.push({ ts: input.ts, text: input.text });
      return Promise.resolve({ channel: channelId, ts: input.ts });
    },
    ephemeral: () => Promise.resolve({ messageTs: '1758351600.000200' }),
    openView: (input) => {
      views.push(input);
      return Promise.resolve({ viewId: 'V1' });
    },
  };
  return { surface, updates, views };
};

export class FakeStatusSource implements StatusSource {
  current: StatusSnapshot = fakeSnapshot();

  snapshot(): Promise<StatusSnapshot> {
    return Promise.resolve(this.current);
  }
}

/**
 * Accepts the tokens it is given, each for its own identity, so a test can
 * prove a route is guarded and sign in as more than one person.
 */
export const fakeVerifier = (
  tokens: string | Record<string, VerifiedIdentity>,
  roles: LanceRole[] = ['Lance.User'],
): TokenVerifier => {
  const known: Record<string, VerifiedIdentity> =
    typeof tokens === 'string' ? { [tokens]: fakeIdentity({ roles }) } : tokens;
  return {
    verify(bearer: string): Promise<VerifiedIdentity> {
      const identity = known[bearer];
      if (identity === undefined) {
        return Promise.reject(new UnauthorisedError('The bearer token was rejected.'));
      }
      return Promise.resolve(identity);
    },
  };
};

/** Principals by oid; an identity it does not know signs in as an onboarding principal. */
export class FakeDirectory implements PrincipalDirectoryLike {
  readonly principals = new Map<string, PrincipalRef>();
  readonly signIns: VerifiedIdentity[] = [];

  constructor(entries: [oid: string, principal: PrincipalRef][] = []) {
    for (const [oid, principal] of entries) this.principals.set(oid, principal);
  }

  signIn(identity: VerifiedIdentity): Promise<PrincipalRef> {
    this.signIns.push(identity);
    const known = this.principals.get(identity.oid);
    if (known !== undefined) return Promise.resolve(known);
    const created = fakePrincipal({
      id: newUlid(),
      upn: identity.upn,
      status: 'onboarding',
      slackUserId: null,
      slackChannelId: null,
      lanceRoles: identity.roles,
    });
    this.principals.set(identity.oid, created);
    return Promise.resolve(created);
  }

  /** A principal's `slackUserId` stands for their active link, as the database keeps it. */
  bySlackUserId(slackUserId: string): Promise<PrincipalRef | null> {
    const found = [...this.principals.values()].find((p) => p.slackUserId === slackUserId);
    return Promise.resolve(found ?? null);
  }

  bySlackChannelId(channelId: string): Promise<PrincipalRef | null> {
    const found = [...this.principals.values()].find((p) => p.slackChannelId === channelId);
    return Promise.resolve(found ?? null);
  }

  byUpn(upn: string): Promise<PrincipalRef | null> {
    const found = [...this.principals.values()].find(
      (p) => p.upn.toLowerCase() === upn.toLowerCase(),
    );
    return Promise.resolve(found ?? null);
  }

  list(): Promise<PrincipalRef[]> {
    return Promise.resolve([...this.principals.values()]);
  }
}

/** Every link request and decision recorded; outcomes set by the test. */
export class FakeSlackLinks implements SlackLinksLike {
  readonly issued: Parameters<SlackLinksLike['issue']>[0][] = [];
  readonly confirmed: { token: string; caller: Caller }[] = [];
  issueResult: SlackLinkIssue = {
    status: 'issued',
    url: 'https://web.example.test/link/slack?state=v1.token',
    expiresAt: '2026-09-24T10:05:00.000Z',
  };
  previewResult: SlackLinkPreview = { status: 'invalid' };
  confirmResult: SlackLinkOutcome = { status: 'invalid' };
  currentResult: SlackLinkState | null = null;

  issue(input: Parameters<SlackLinksLike['issue']>[0]): Promise<SlackLinkIssue> {
    this.issued.push(input);
    return Promise.resolve(this.issueResult);
  }

  preview(): Promise<SlackLinkPreview> {
    return Promise.resolve(this.previewResult);
  }

  confirm(token: string, caller: Caller): Promise<SlackLinkOutcome> {
    this.confirmed.push({ token, caller });
    return Promise.resolve(this.confirmResult);
  }

  current(): Promise<SlackLinkState | null> {
    return Promise.resolve(this.currentResult);
  }

  readonly unlinked: Parameters<SlackLinksLike['unlink']>[0][] = [];
  unlinkResult = true;

  unlink(input: Parameters<SlackLinksLike['unlink']>[0]): Promise<boolean> {
    this.unlinked.push(input);
    return Promise.resolve(this.unlinkResult);
  }
}

/** The replay rule in memory: a signature is accepted once. */
export class FakeReplayGuard {
  readonly seen = new Set<string>();

  claim(signature: string): Promise<boolean> {
    if (this.seen.has(signature)) return Promise.resolve(false);
    this.seen.add(signature);
    return Promise.resolve(true);
  }
}

export const fakeHealth = (overrides: Partial<PrincipalHealth> = {}): PrincipalHealth => ({
  principalId: TEST_PRINCIPAL_ID,
  upn: TEST_UPN,
  status: 'active',
  watchers: [{ watcher: 'graph-mail', lastRunAgeMinutes: 3 }],
  breakers: [],
  secrets: [
    { connector: 'graph', state: 'stored', recordedAt: '2026-09-20T09:00:00.000Z' },
    { connector: 'jamie', state: 'never_stored', recordedAt: null },
  ],
  costTodayGbp: 1.5,
  costWeekGbp: 7.25,
  ...overrides,
});

export class FakeAdminStore implements AdminStoreLike {
  readonly offboardings: OffboardingRequest[] = [];
  readonly alertsFor: string[] = [];

  constructor(private readonly directory: PrincipalDirectoryLike) {}

  async principals(): Promise<AdminPrincipalView[]> {
    const all = await this.directory.list();
    return all.map((p) => ({
      id: p.id,
      upn: p.upn,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      onboarding: onboardingProgress(new Set(['slack_linked'])),
    }));
  }

  async health(): Promise<PrincipalHealth[]> {
    const all = await this.directory.list();
    return all.map((p) => fakeHealth({ principalId: p.id, upn: p.upn, status: p.status }));
  }

  ruleChanges(): Promise<RuleChangeView[]> {
    return Promise.resolve([]);
  }

  systemAlerts(adminPrincipalId: string): Promise<SystemAlertView[]> {
    this.alertsFor.push(adminPrincipalId);
    return Promise.resolve([]);
  }

  requestOffboarding(request: OffboardingRequest): Promise<OffboardingQueued> {
    if (request.principalId === request.callerId) {
      return Promise.reject(new BadRequestError('An admin cannot offboard themselves.'));
    }
    this.offboardings.push(request);
    return Promise.resolve({
      status: 'queued',
      principalId: request.principalId,
      jobId: 'job-offboard',
    });
  }
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  /** Anything `jose` accepts: "5m", a Unix second count, or a Date. */
  expiresAt?: string | number | Date;
  /** Leave `exp` out entirely, to prove the verifier requires it. */
  omitExpiry?: boolean;
}

export interface TestJwks {
  jwks: JWTVerifyGetKey;
  /** Signs a token with the matching private key. */
  sign(claims: Record<string, unknown>, options?: SignOptions): Promise<string>;
}

/**
 * A locally generated RSA key served through `createLocalJWKSet`, so the
 * Entra verifier can be exercised end to end without reaching Microsoft.
 */
export const createTestJwks = async (issuer: string, audience: string): Promise<TestJwks> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';

  return {
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
    async sign(claims: Record<string, unknown>, options: SignOptions = {}): Promise<string> {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? audience)
        .setIssuedAt();
      if (!options.omitExpiry) jwt.setExpirationTime(options.expiresAt ?? '5m');
      return jwt.sign(privateKey);
    },
  };
};

/** An onboarding principal who has done nothing yet, as `onboarding.state` answers. */
export const fakeOnboardingState = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  status: 'onboarding',
  notice: { done: false, acceptedAt: null, changedSinceAcceptance: false },
  graph: { done: false, connectedAt: null },
  jamie: { done: false, connectedAt: null },
  foundry: { required: false, arrivesLater: true },
  slack: { done: false, linkedAt: null },
  preferences: {
    done: false,
    confirmedAt: null,
    timeZone: 'Europe/London',
    quietHoursStart: '19:00',
    quietHoursEnd: '07:00',
    source: 'defaults',
  },
  missing: ['notice', 'graph', 'jamie', 'slack', 'preferences'],
  ...overrides,
});

/** Records every onboarding call; the state it answers is whatever the test sets. */
export class FakeOnboarding implements OnboardingServiceLike {
  current: OnboardingState = fakeOnboardingState();
  readonly accepted: { principalId: string; noticeSha256: string; actor: string }[] = [];
  readonly confirmed: { principalId: string; input: PreferencesInput; actor: string }[] = [];
  readonly completions: string[] = [];
  completion: CompletionResult | Error = { status: 'already_active' };

  state(): Promise<OnboardingState> {
    return Promise.resolve(this.current);
  }

  acceptNotice(principal: PrincipalRef, noticeSha256: string, actor: string): Promise<void> {
    this.accepted.push({ principalId: principal.id, noticeSha256, actor });
    return Promise.resolve();
  }

  confirmPreferences(
    principal: PrincipalRef,
    input: PreferencesInput,
    actor: string,
  ): Promise<void> {
    this.confirmed.push({ principalId: principal.id, input, actor });
    return Promise.resolve();
  }

  complete(principal: PrincipalRef): Promise<CompletionResult> {
    this.completions.push(principal.id);
    return this.completion instanceof Error
      ? Promise.reject(this.completion)
      : Promise.resolve(this.completion);
  }
}

export interface FakeDepsOverrides {
  config?: Config;
  control?: SystemControlLike;
  ledger?: LedgerReaderLike;
  writer?: LedgerWriterLike;
  status?: StatusSource;
  auth?: TokenVerifier;
  /** The signed-in principal's Slack id. Null leaves every Slack user unknown. */
  allowedSlackUserId?: string | null;
  /** The principal the test token signs in as. */
  principal?: PrincipalRef;
  directory?: FakeDirectory;
  graph?: GraphConsentDeps;
  jamieKeys?: JamieKeyDeps;
  /** Omit the Slack surface, as a process with no bot token has. */
  withoutSlackSurface?: boolean;
  now?: () => string;
}

export interface FakeDeps {
  deps: ApiDeps;
  /** The server around `deps`: every principal the directory knows gets these same deps. */
  server: ServerDeps;
  directory: FakeDirectory;
  control: FakeSystemControl;
  ledger: FakeLedgerReader;
  writer: FakeLedgerWriter;
  proposals: FakeProposalStore;
  decider: FakeDecider;
  slack: FakeSlackSurface;
  feed: Feed;
  events: FeedEvent[];
  status: FakeStatusSource;
  commitments: FakeCommitmentStore;
  tasks: FakeTaskStore;
  briefs: FakeBriefStore;
  alerts: FakeAlertStore;
  agents: FakeAgentsStore;
  ontology: FakeOntology;
  /** Alert ids whose Slack card could not be redrawn, in order. */
  slackFailures: string[];
  /** Proposal ids handed to `enqueueExecute`, in order. */
  enqueued: string[];
  /** Commitment ids handed to `enqueueChase`, in order. */
  chased: string[];
  /** One entry per `/lance brief` request. */
  briefRequests: number[];
  jobs: FakeJobs;
  /** Alerts raised through `deps.raiseAlert`, in order. */
  raised: Omit<RaiseAlertInput, 'now'>[];
  links: FakeSlackLinks;
  replay: FakeReplayGuard;
  onboarding: FakeOnboarding;
}

export const fakeDeps = (overrides: FakeDepsOverrides = {}): FakeDeps => {
  const control = new FakeSystemControl();
  const ledger = new FakeLedgerReader();
  const writer = new FakeLedgerWriter();
  const proposals = new FakeProposalStore();
  const decider = new FakeDecider();
  const slack = fakeSlackSurface();
  const status = new FakeStatusSource();
  const feed = createFeed();
  const events: FeedEvent[] = [];
  feed.subscribe((event) => events.push(event));
  const enqueued: string[] = [];
  const chased: string[] = [];
  const briefRequests: number[] = [];
  const commitments = new FakeCommitmentStore();
  const tasks = new FakeTaskStore();
  const briefs = new FakeBriefStore();
  const alerts = new FakeAlertStore();
  const agents = new FakeAgentsStore();
  const ontology = new FakeOntology();
  const slackFailures: string[] = [];
  const jobs = new FakeJobs();
  const raised: Omit<RaiseAlertInput, 'now'>[] = [];
  const links = new FakeSlackLinks();
  const replay = new FakeReplayGuard();
  const onboarding = new FakeOnboarding();

  const config = overrides.config ?? testConfig();
  const principal =
    overrides.principal ??
    fakePrincipal(
      overrides.allowedSlackUserId === undefined
        ? {}
        : { slackUserId: overrides.allowedSlackUserId },
    );
  const directory = overrides.directory ?? new FakeDirectory([[TEST_OID, principal]]);

  const deps: ApiDeps = {
    config,
    principalId: principal.id,
    actor: 'user:dom',
    upn: principal.upn,
    control: overrides.control ?? control,
    ledger: overrides.ledger ?? ledger,
    writer: overrides.writer ?? writer,
    proposals,
    decide: (request) => decider.decide(request),
    enqueueExecute: (proposalId) => {
      enqueued.push(proposalId);
      return Promise.resolve();
    },
    commitments,
    tasks,
    briefs,
    alerts,
    raiseAlert: (input): Promise<RaiseAlertResult> => {
      raised.push(input);
      return Promise.resolve({
        alertId: newUlid(),
        count: 1,
        created: true,
        reopened: false,
        eventId: newUlid(),
      });
    },
    agents,
    ontology,
    enqueueBrief: () => {
      briefRequests.push(1);
      return Promise.resolve('job-brief');
    },
    enqueueChase: (commitmentId) => {
      chased.push(commitmentId);
      return Promise.resolve(`job-${String(chased.length)}`);
    },
    jobs,
    status: overrides.status ?? status,
    slackSurface: overrides.withoutSlackSurface === true ? null : slack.surface,
    onAlertSlackFailure: (_error, alertId) => {
      slackFailures.push(alertId);
    },
    notify: (event) => {
      feed.notify(event);
    },
    subscribe: (listener) => feed.subscribe(listener),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };

  const server: ServerDeps = {
    config,
    auth: overrides.auth ?? fakeVerifier('good-token'),
    directory,
    depsFor: () => deps,
    admin: new FakeAdminStore(directory),
    onboarding,
    noticeSha256: TEST_NOTICE_SHA256,
    readiness: async () => {
      const state = await deps.control.read();
      return { paused: state.paused, mode: state.mode };
    },
    slack: { signingSecret: TEST_SIGNING_SECRET, fallbackUserId: null, links, replay },
    ingestSecret: TEST_INGEST_SECRET,
    ...(overrides.graph === undefined ? {} : { graph: overrides.graph }),
    ...(overrides.jamieKeys === undefined ? {} : { jamieKeys: overrides.jamieKeys }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };

  return {
    deps,
    server,
    directory,
    control,
    ledger,
    writer,
    proposals,
    decider,
    slack,
    feed,
    events,
    status,
    commitments,
    tasks,
    briefs,
    alerts,
    agents,
    ontology,
    slackFailures,
    enqueued,
    chased,
    briefRequests,
    jobs,
    raised,
    links,
    replay,
    onboarding,
  };
};

/**
 * A tRPC context for a direct caller: the harness's principal, signed in
 * with `roles`, unless a test names another principal.
 */
export const fakeContext = (
  harness: FakeDeps,
  options: { roles?: LanceRole[]; principal?: PrincipalRef } = {},
): ApiContext => {
  const principal = options.principal ?? fakePrincipal({ id: harness.deps.principalId });
  return {
    server: harness.server,
    caller: {
      identity: fakeIdentity({ upn: principal.upn, roles: options.roles ?? ['Lance.User'] }),
      principal,
    },
    deps: harness.deps,
    upn: principal.upn,
  };
};

/**
 * The consent state store without a database, keeping the Postgres
 * store's rules: bind once, claim once after a bind, nothing after expiry.
 * `principalFor` answers what the store reads from `principals`.
 */
export class FakeConsentStates implements ConsentStateStoreLike {
  readonly rows = new Map<
    string,
    { principalId: string; codeVerifier: string; bound: boolean; used: boolean; expired: boolean }
  >();

  constructor(readonly principalFor: (principalId: string) => ConsentPrincipal | undefined) {}

  issue(principalId: string, state: string, codeVerifier: string): Promise<void> {
    this.rows.set(state, { principalId, codeVerifier, bound: false, used: false, expired: false });
    return Promise.resolve();
  }

  bind(state: string): Promise<ClaimedConsent | null> {
    return Promise.resolve(this.advance(state, 'bound'));
  }

  claim(state: string): Promise<ClaimedConsent | null> {
    return Promise.resolve(this.advance(state, 'used'));
  }

  private advance(state: string, step: 'bound' | 'used'): ClaimedConsent | null {
    const row = this.rows.get(state);
    if (row === undefined || row.used || row.expired) return null;
    if (step === 'bound' ? row.bound : !row.bound) return null;
    row[step] = true;
    const principal = this.principalFor(row.principalId);
    return principal === undefined ? null : { codeVerifier: row.codeVerifier, principal };
  }
}

/** Consent states whose principals are the directory's, each bound to the oid it is keyed by. */
export const fakeConsentStates = (directory: FakeDirectory): FakeConsentStates =>
  new FakeConsentStates((principalId) => {
    for (const [oid, principal] of directory.principals) {
      if (principal.id === principalId) {
        return { id: principal.id, upn: principal.upn, entraOid: oid };
      }
    }
    return undefined;
  });
