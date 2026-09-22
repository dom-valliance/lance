import type { SlackSurface } from '@lance/connectors';
import type { Alert, Commitment, SystemState } from '@lance/db';
import type {
  DecisionResult,
  CostCeiling,
  InterruptionBudget,
  LedgerEventRow,
  LedgerQuery,
  PauseResult,
  ProposalFilter,
  ResumeResult,
} from '@lance/ledger';
import {
  loadConfig,
  newUlid,
  type Config,
  type LedgerEventInputCandidate,
  type Proposal,
  type SystemMode,
} from '@lance/shared';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type {
  ApiDeps,
  LedgerReaderLike,
  LedgerWriterLike,
  OntologyLike,
  OntologyNodeLike,
  ProposalStoreLike,
  SystemControlLike,
  TokenVerifier,
} from './deps.js';
import type { AgentLastRun, AgentRunRow, AgentsStoreLike, CursorRow } from './agents/store.js';
import type { AlertQuery, AlertStoreLike, SetAlertStatusInput } from './alerts/store.js';
import type { BriefQuery, BriefRecord, BriefStoreLike, LatestBriefQuery } from './briefs/store.js';
import type { CommitmentQuery, CommitmentStoreLike } from './commitments/store.js';
import type { TaskQuery, TaskStoreLike } from './tasks/store.js';
import { toTaskView, type ObservationRecord } from './tasks/view.js';
import { UnauthorisedError } from './errors.js';
import { createFeed, type Feed, type FeedEvent } from './events.js';
import type { DecisionRequest } from './proposals/decide.js';
import type { StatusSnapshot, StatusSource } from './status.js';

/**
 * Fakes and builders for the test suite. Not exported from the package
 * entry point and never imported by a route: the api ships the real
 * collaborators and tests inject these.
 */

export const TEST_UPN = 'dom@valliance.ai';
export const TEST_SIGNING_SECRET = 'slack-signing-secret-for-tests';
export const TEST_INGEST_SECRET = 'ingest-secret-for-tests';
export const TEST_SLACK_USER_ID = 'U0DOM';

export const testConfig = (env: NodeJS.ProcessEnv = {}): Config =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
    ...env,
  });

export const fakeSystemState = (overrides: Partial<SystemState> = {}): SystemState => ({
  id: 1,
  paused: false,
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
  state: SystemState = fakeSystemState();
  readonly pauseCalls: { reason: string; actor: string }[] = [];
  readonly resumeCalls: { actor: string }[] = [];
  readFails = false;

  read(): Promise<SystemState> {
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

  setMode(
    mode: SystemMode,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }> {
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

export class FakeLedgerReader implements LedgerReaderLike {
  rows: LedgerEventRow[] = [];
  readonly queries: (LedgerQuery | undefined)[] = [];

  query(filter?: LedgerQuery): Promise<LedgerEventRow[]> {
    this.queries.push(filter);
    return Promise.resolve(this.rows);
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

export class FakeProposalStore implements ProposalStoreLike {
  rows: Proposal[] = [fakeProposal()];
  readonly filters: (ProposalFilter | undefined)[] = [];

  list(filter?: ProposalFilter): Promise<Proposal[]> {
    this.filters.push(filter);
    return Promise.resolve(this.rows);
  }

  get(id: string): Promise<Proposal | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }
}

export const TEST_COMMITMENT_ID = '01K5S9V6QW3SWCCPVB0N0E302A';
export const TEST_PERSON_ID = 'per-ann';

export const fakeCommitment = (overrides: Partial<Commitment> = {}): Commitment => ({
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

  list(query: CommitmentQuery): Promise<Commitment[]> {
    this.queries.push(query);
    const matched = this.rows
      .filter((row) => query.direction === undefined || row.direction === query.direction)
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(matched.slice(0, query.limit));
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

  list(query: AlertQuery): Promise<Alert[]> {
    this.queries.push(query);
    const matched = this.rows
      .filter((row) => query.status === undefined || row.status === query.status)
      .filter((row) => query.severity === undefined || row.severity === query.severity)
      .filter((row) => query.kind === undefined || row.kind === query.kind)
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(matched.slice(0, query.limit));
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
  readonly queries: TaskQuery[] = [];

  list(query: TaskQuery): Promise<ObservationRecord[]> {
    this.queries.push(query);
    const options = { domNotionUserId: '1fdd872b-594c-8146-b22f-00028f1f5a41' };
    const matched = this.rows
      .filter((row) => query.source === undefined || row.sourceSystem === query.source)
      .filter((row) => {
        if (query.status === undefined) return true;
        const view = toTaskView(row, options);
        return view !== null && view.done === (query.status === 'done');
      })
      .filter((row) => query.cursor === undefined || row.id < query.cursor)
      .sort((left, right) => (left.id < right.id ? 1 : -1));
    return Promise.resolve(matched.slice(0, query.limit));
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

/** Accepts exactly one token, so a test can prove a route is guarded. */
export const fakeVerifier = (token: string, upn = TEST_UPN): TokenVerifier => ({
  verify(bearer: string): Promise<{ upn: string }> {
    if (bearer !== token) {
      return Promise.reject(new UnauthorisedError('The bearer token was rejected.'));
    }
    return Promise.resolve({ upn });
  },
});

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

export interface FakeDepsOverrides {
  config?: Config;
  control?: SystemControlLike;
  ledger?: LedgerReaderLike;
  writer?: LedgerWriterLike;
  status?: StatusSource;
  auth?: TokenVerifier;
  allowedSlackUserId?: string | null;
  /** Omit the Slack surface, as a process with no bot token has. */
  withoutSlackSurface?: boolean;
  now?: () => string;
}

export interface FakeDeps {
  deps: ApiDeps;
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

  const deps: ApiDeps = {
    config: overrides.config ?? testConfig(),
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
    status: overrides.status ?? status,
    auth: overrides.auth ?? fakeVerifier('good-token'),
    slack: {
      signingSecret: TEST_SIGNING_SECRET,
      allowedUserId:
        overrides.allowedSlackUserId === undefined
          ? TEST_SLACK_USER_ID
          : overrides.allowedSlackUserId,
    },
    slackSurface: overrides.withoutSlackSurface === true ? null : slack.surface,
    onAlertSlackFailure: (_error, alertId) => {
      slackFailures.push(alertId);
    },
    notify: (event) => {
      feed.notify(event);
    },
    subscribe: (listener) => feed.subscribe(listener),
    ingestSecret: TEST_INGEST_SECRET,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };

  return {
    deps,
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
  };
};
