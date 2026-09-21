import type { SlackSurface } from '@lance/connectors';
import type { SystemState } from '@lance/db';
import type {
  DecisionResult,
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
} from '@lance/shared';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type {
  ApiDeps,
  LedgerReaderLike,
  LedgerWriterLike,
  ProposalStoreLike,
  SystemControlLike,
  TokenVerifier,
} from './deps.js';
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
  /** Proposal ids handed to `enqueueExecute`, in order. */
  enqueued: string[];
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
    enqueued,
  };
};
