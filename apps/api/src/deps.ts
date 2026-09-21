import type { SlackSurface } from '@lance/connectors';
import type { SystemState } from '@lance/db';
import type {
  AppendResult,
  DecisionResult,
  LedgerEventRow,
  LedgerQuery,
  PauseResult,
  ProposalFilter,
  ResumeResult,
} from '@lance/ledger';
import type { Config, LedgerEventInputCandidate, Proposal } from '@lance/shared';
import type { FeedEvent, FeedListener } from './events.js';
import type { DecisionRequest } from './proposals/decide.js';
import type { StatusSource } from './status.js';

/**
 * Everything `buildServer` needs, as structural subsets of the real
 * classes. `SystemControl`, `LedgerReader` and `LedgerWriter` all satisfy
 * these without knowing about them, so `main.ts` passes the real things and
 * a test passes a fake without a database.
 */

export interface SystemControlLike {
  read(): Promise<SystemState>;
  pause(options: { reason: string; actor: string }): Promise<PauseResult>;
  resume(options: { actor: string }): Promise<ResumeResult>;
}

export interface LedgerReaderLike {
  query(filter?: LedgerQuery): Promise<LedgerEventRow[]>;
  byCorrelation(correlationId: string): Promise<LedgerEventRow[]>;
}

/** The read side of `proposals`, over the database or over a fake. */
export interface ProposalStoreLike {
  list(filter?: ProposalFilter): Promise<Proposal[]>;
  get(id: string): Promise<Proposal | null>;
}

export interface LedgerWriterLike {
  append(candidate: LedgerEventInputCandidate): Promise<AppendResult>;
}

/** Turns a bearer token into the caller's UPN, or throws `UnauthorisedError`. */
export interface TokenVerifier {
  verify(bearer: string): Promise<{ upn: string }>;
}

export interface SlackDeps {
  signingSecret: string;
  /**
   * Dom's Slack user id, from `users.slack_user_id`. Only this user may
   * pause or resume from Slack. Null refuses every such command, which is
   * the safe default before the id is recorded.
   */
  allowedUserId: string | null;
}

/**
 * Where the delegated Graph refresh token lives. Structural, like the
 * other `*Like` types here: `KeyVaultTokenStore` from `@lance/connectors`
 * satisfies it without knowing about the api, and a test passes a double.
 */
export interface GraphTokenStoreLike {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
}

/** Everything `/auth/graph/connect` and `/auth/graph/callback` need (spec 4.1). */
export interface GraphConsentDeps {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Origin the browser reaches the api on, from `PUBLIC_API_URL`. */
  publicApiUrl: string;
  tokenStore: GraphTokenStoreLike;
}

export interface ApiDeps {
  config: Config;
  control: SystemControlLike;
  ledger: LedgerReaderLike;
  writer: LedgerWriterLike;
  proposals: ProposalStoreLike;
  /** `applyDecision` bound to everything it needs; the one way a proposal changes state. */
  decide: (request: DecisionRequest) => Promise<DecisionResult>;
  status: StatusSource;
  auth: TokenVerifier;
  slack: SlackDeps;
  /**
   * How Lance speaks in its own channel (ADR 0012). Null when
   * `SLACK_BOT_TOKEN` is absent, so a local run answers interactions
   * without a token instead of failing at construction.
   */
  slackSurface: SlackSurface | null;
  /** Fans a live update out to every client connected to `GET /events`. */
  notify: (event: FeedEvent) => void;
  /** Registers one such client. Returns the function that removes it. */
  subscribe: (listener: FeedListener) => () => void;
  /** Shared secret for `POST /ingest/agent-log` (spec 7.1, agent-logs). */
  ingestSecret: string;
  /**
   * Absent in a process that was not given the Entra app credentials, the
   * public api URL and a token store; the consent routes then answer 503
   * naming what is missing rather than half-running the flow.
   */
  graph?: GraphConsentDeps;
  /** Injected in tests. Returns an ISO-8601 instant with an explicit offset. */
  now?: () => string;
}

/** The ledger actor for everything Dom triggers, in Slack or in the api. */
export const DOM_ACTOR = 'user:dom';
