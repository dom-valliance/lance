import type { SlackSurface } from '@lance/connectors';
import type {
  AppendResult,
  RaiseAlertInput,
  RaiseAlertResult,
  DecisionResult,
  CostCeiling,
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
import type {
  Config,
  LanceRole,
  LedgerEventInputCandidate,
  Proposal,
  SystemMode,
} from '@lance/shared';
import type { PRINCIPAL_STATUS_VALUES } from '@lance/db';
import type { AgentsStoreLike } from './agents/store.js';
import type { AlertStoreLike } from './alerts/store.js';
import type { BriefStoreLike } from './briefs/store.js';
import type { CommitmentStoreLike } from './commitments/store.js';
import type { FeedEvent, FeedListener } from './events.js';
import type { JobsServiceLike } from './jobs/service.js';
import type { ReplayGuardLike } from './slack/replay.js';
import type { DecisionRequest } from './proposals/decide.js';
import type { StatusSource } from './status.js';
import type { TaskStoreLike } from './tasks/store.js';

/**
 * Everything `buildServer` needs, as structural subsets of the real
 * classes. `SystemControl`, `LedgerReader` and `LedgerWriter` all satisfy
 * these without knowing about them, so `main.ts` passes the real things and
 * a test passes a fake without a database.
 */

export interface SystemControlLike {
  read(): Promise<RunState>;
  pause(options: { reason: string; actor: string }): Promise<PauseResult>;
  resume(options: { actor: string }): Promise<ResumeResult>;
  /** Sets the global row, which pauses every principal (ADR 0015). */
  pauseAll(options: { reason: string; actor: string }): Promise<PauseResult>;
  /** Clears the global row; each principal's own pause, and their held proposals, stay. */
  resumeAll(options: { actor: string }): Promise<{ changed: boolean; eventId: string }>;
  /** Switches between dry run and live (spec 6.3); records a state_changed event either way. */
  setMode(
    mode: SystemMode,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }>;
  /** Sets the quiet hours and the hourly push ceiling (spec 9.1). */
  setInterruptionBudget(
    budget: InterruptionBudget,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }>;
  /** Sets the daily model spend ceiling (spec 13). */
  setCostCeiling(
    ceiling: CostCeiling,
    options: { actor: string },
  ): Promise<{ changed: boolean; eventId: string }>;
}

export interface LedgerReaderLike {
  query(filter?: LedgerQuery): Promise<LedgerEventRow[]>;
  /** Every event `query` would match with no row limit. */
  count(filter?: LedgerCountQuery): Promise<number>;
  /** One event by id, or null; resolves a page cursor. */
  get(id: string): Promise<LedgerEventRow | null>;
  byCorrelation(correlationId: string): Promise<LedgerEventRow[]>;
}

/** The read side of `proposals`, over the database or over a fake. */
export interface ProposalStoreLike {
  list(filter?: ProposalFilter): Promise<Proposal[]>;
  /** Every proposal `list` would return across all its pages. */
  count(filter?: ProposalCountFilter): Promise<number>;
  /** The pending count and the earliest expiry among them, for the page header. */
  summary(): Promise<PendingProposalSummary>;
  get(id: string): Promise<Proposal | null>;
}

export interface LedgerWriterLike {
  append(candidate: LedgerEventInputCandidate): Promise<AppendResult>;
}

/**
 * Person names on the Commitments page come from the graph, not from the
 * commitments table. Structural like the rest: `OntologyRepository`
 * satisfies it, and a test passes a map of nodes.
 */
export interface OntologyNodeLike {
  properties: Record<string, unknown>;
}

export interface OntologyLike {
  getNode(id: string): Promise<OntologyNodeLike | null>;
}

/** Who a verified Entra token says is calling (ADR 0020). */
export interface VerifiedIdentity {
  /** The Entra object id, `oid`: the stable key a principal is bound to. */
  oid: string;
  upn: string;
  /** The Lance app roles in the token's `roles` claim; empty when it holds neither. */
  roles: LanceRole[];
}

/** Turns a bearer token into the caller's identity, or throws `UnauthorisedError`. */
export interface TokenVerifier {
  verify(bearer: string): Promise<VerifiedIdentity>;
}

export type PrincipalStatus = (typeof PRINCIPAL_STATUS_VALUES)[number];

/** The slice of a `principals` row the api routes on. */
export interface PrincipalRef {
  id: string;
  upn: string;
  status: PrincipalStatus;
  /** The Slack user of the principal's active link (ADR 0021); null until they link. */
  slackUserId: string | null;
  /** The principal's private channel (ADR 0023); null until their first link. */
  slackChannelId: string | null;
  /**
   * The Lance roles their last verified Entra token carried, recorded at
   * each sign-in and at the Slack link. What a Slack request, which carries
   * no token, is gated on.
   */
  lanceRoles: LanceRole[];
  createdAt: Date;
}

/**
 * Enough of a principal to build its dependencies: the scope, the ledger
 * actor and, when the caller has it, the channel its Slack surface posts
 * to. A key without the channel reuses whatever was built for the
 * principal before; one with it rebuilds when the channel has changed.
 */
export type PrincipalKey = Pick<PrincipalRef, 'id' | 'upn'> &
  Partial<Pick<PrincipalRef, 'slackChannelId'>>;

/** The identity behind a request, once `requireEntra` has resolved it. */
export interface Caller {
  identity: VerifiedIdentity;
  principal: PrincipalRef;
}

/**
 * The lookup from an identity to a principal. `signIn` is the first-sign-in
 * path of ADR 0020: it finds the principal bound to the token's `oid`,
 * binds the `oid` to an unbound row carrying the token's UPN, or creates an
 * `onboarding` principal, and records a ledger event for either write.
 */
export interface PrincipalDirectoryLike {
  signIn(identity: VerifiedIdentity): Promise<PrincipalRef>;
  /**
   * The principal a Slack user acts for, through their active row in
   * `slack_links` (ADR 0021), or null when they have not linked. A team id,
   * when the request carries one, must match the link's.
   */
  bySlackUserId(slackUserId: string, slackTeamId?: string | null): Promise<PrincipalRef | null>;
  /** The principal whose private channel this is (ADR 0023), or null. */
  bySlackChannelId(channelId: string): Promise<PrincipalRef | null>;
  byUpn(upn: string): Promise<PrincipalRef | null>;
  list(): Promise<PrincipalRef[]>;
}

export interface SlackDeps {
  signingSecret: string;
  /**
   * `SLACK_ALLOWED_USER_ID`: until Dom has linked through `/lance login`, a
   * Slack user with this id acts for the principal whose UPN is
   * `config.dom.email`. Ignored once that principal has a link, and retired
   * once Dom has linked (docs/runbooks/slack-app-setup.md). Null when unset.
   */
  fallbackUserId: string | null;
  /** `/lance login` and the web route it links to (ADR 0021). */
  links: SlackLinksLike;
  /** Refuses a signed request seen before inside the replay window. */
  replay: ReplayGuardLike;
}

/** A `/lance login` link, to answer in Slack. */
export type SlackLinkIssue =
  | { status: 'issued'; url: string; expiresAt: string }
  /** `PUBLIC_WEB_URL` is not set on the api, so there is nowhere to link to. */
  | { status: 'unconfigured' };

/** Why a link cannot be used. The web page words each one itself. */
export type SlackLinkRefusal =
  /** Malformed, tampered with, or naming no nonce Lance issued. */
  | 'invalid'
  | 'expired'
  | 'used'
  /** The Slack user is linked, or was, to another principal. */
  | 'taken'
  /** The signed-in principal is paused or offboarded. */
  | 'inactive';

/** What the link page shows before the person confirms. */
export type SlackLinkPreview =
  | {
      status: 'ready';
      slackUserId: string;
      slackTeamId: string;
      /** From Slack's profile when the bot token can read it; null otherwise. */
      slackName: string | null;
      expiresAt: string;
      /** True when this Slack user is already linked to the signed-in principal. */
      alreadyLinked: boolean;
    }
  | { status: SlackLinkRefusal };

/** The principal's private channel after a link. */
export type SlackChannelOutcome =
  | { status: 'ready'; channelId: string; name: string | null; created: boolean }
  /** No bot token on the api, so no channel could be made. The link stands. */
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

export type SlackLinkOutcome =
  | {
      status: 'linked';
      slackUserId: string;
      slackTeamId: string;
      channel: SlackChannelOutcome;
      /** Things the person should know that did not stop the link, such as a directory mismatch. */
      warnings: string[];
    }
  | { status: SlackLinkRefusal };

/** The signed-in principal's link as it stands, for the page after a reload. */
export interface SlackLinkState {
  slackUserId: string;
  slackTeamId: string;
  linkedAt: string;
  channelId: string | null;
}

export interface SlackLinksLike {
  /**
   * Stores a nonce and returns the link. `recordFor` is the principal whose
   * ledger records the request: the one the Slack user already acts for,
   * or the organisation's admin for a user not linked yet.
   */
  issue(input: {
    slackUserId: string;
    slackTeamId: string;
    recordFor: PrincipalKey;
    actor: string;
  }): Promise<SlackLinkIssue>;
  preview(token: string, principal: PrincipalRef): Promise<SlackLinkPreview>;
  /** Consumes the token and binds its Slack user to the caller's principal. */
  confirm(token: string, caller: Caller): Promise<SlackLinkOutcome>;
  current(principal: PrincipalRef): Promise<SlackLinkState | null>;
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

/**
 * Everything one principal's requests run over (ADR 0015): each store reads
 * and writes through a handle scoped to that principal. `depsFor` in
 * `ServerDeps` builds one per principal and reuses it.
 */
export interface ApiDeps {
  config: Config;
  /** The principal every store here is scoped to. */
  principalId: string;
  /** The ledger actor for what this principal does by hand, `user:<name>`. */
  actor: string;
  /** The principal's UPN. */
  upn: string;
  control: SystemControlLike;
  ledger: LedgerReaderLike;
  writer: LedgerWriterLike;
  proposals: ProposalStoreLike;
  /** `applyDecision` bound to everything it needs; the one way a proposal changes state. */
  decide: (request: DecisionRequest) => Promise<DecisionResult>;
  /**
   * Puts an approved proposal on the execute queue. A resume releases held
   * proposals back to approved, and each one is re-queued through this so
   * "released" means the executor will pick it up.
   */
  enqueueExecute: (proposalId: string) => Promise<void>;
  /** Reads and the two status writes behind the Commitments page. */
  commitments: CommitmentStoreLike;
  /** The aggregated task read behind the Tasks page. */
  tasks: TaskStoreLike;
  /** The generated briefs behind the Today page. */
  briefs: BriefStoreLike;
  /** Reads and the three status writes behind the Alerts page. */
  alerts: AlertStoreLike;
  /** Raises an alert in this principal's scope, as the worker does (spec 11). */
  raiseAlert: (input: Omit<RaiseAlertInput, 'now'>) => Promise<RaiseAlertResult>;
  /** Cursors, agent runs and pushes behind the Agents page. */
  agents: AgentsStoreLike;
  /** Person nodes, for the owner and counterparty of a commitment. */
  ontology: OntologyLike;
  /**
   * Puts a commitment on the `chase` queue and returns the job id. The
   * worker drafts the chase; the api never writes an email.
   */
  enqueueChase: (commitmentId: string) => Promise<string>;
  /** `/lance brief`: the worker regenerates the morning brief now. */
  enqueueBrief: () => Promise<string>;
  /** The principal's jobs behind `/lance jobs`, `pause <job>` and `resume <job>` (ADR 0025). */
  jobs: JobsServiceLike;
  status: StatusSource;
  /**
   * How Lance speaks in this principal's channel (ADR 0012, ADR 0023). Null
   * when `SLACK_BOT_TOKEN` is absent, so a local run answers interactions
   * without a token instead of failing at construction, and null for a
   * principal with no channel yet.
   */
  slackSurface: SlackSurface | null;
  /**
   * Called when an alert card could not be redrawn. The state change has
   * already landed by then, so the failure is reported rather than thrown.
   */
  onAlertSlackFailure?: (error: unknown, alertId: string) => void;
  /** Fans a live update out to every client connected to `GET /events`. */
  notify: (event: FeedEvent) => void;
  /** Registers one such client. Returns the function that removes it. */
  subscribe: (listener: FeedListener) => () => void;
  /** Injected in tests. Returns an ISO-8601 instant with an explicit offset. */
  now?: () => string;
}

/** Health for one principal, as a `Lance.Admin` sees it (ADR 0024). No content. */
export interface PrincipalHealth {
  principalId: string;
  upn: string;
  status: PrincipalStatus;
  watchers: { watcher: string; lastRunAgeMinutes: number }[];
  breakers: { connector: string; state: 'open' }[];
  costTodayGbp: number;
  costWeekGbp: number;
}

/** A principal as the admin list shows it (ADR 0024). */
export interface AdminPrincipalView {
  id: string;
  upn: string;
  status: PrincipalStatus;
  createdAt: string;
}

/** The reads behind the admin procedures, each computed in the principal's own scope. */
export interface AdminStoreLike {
  principals(): Promise<AdminPrincipalView[]>;
  health(): Promise<PrincipalHealth[]>;
}

/**
 * What the server itself needs, beyond any one principal: the token check,
 * the identity lookup, the per-principal dependency cache and the secrets
 * of the unauthenticated routes.
 */
export interface ServerDeps {
  config: Config;
  auth: TokenVerifier;
  directory: PrincipalDirectoryLike;
  /** One principal's dependencies, built on first use and reused after. */
  depsFor: (principal: PrincipalKey) => ApiDeps;
  admin: AdminStoreLike;
  /** The global `system_state` row, for the readiness probe. */
  readiness: () => Promise<{ paused: boolean; mode: SystemMode }>;
  slack: SlackDeps;
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

/** The ledger actor Dom's own actions carried before actors came from the principal. */
export const DOM_ACTOR = 'user:dom';

/**
 * Resumes and re-queues every released proposal (spec 4.3). Both the Slack
 * command and the admin route go through here so neither can release a
 * proposal that nothing then executes.
 */
export async function resumeAndRequeue(
  deps: Pick<ApiDeps, 'control' | 'enqueueExecute' | 'actor'>,
): Promise<ResumeResult> {
  const result = await deps.control.resume({ actor: deps.actor });
  for (const proposalId of result.releasedProposalIds) {
    await deps.enqueueExecute(proposalId);
  }
  return result;
}
