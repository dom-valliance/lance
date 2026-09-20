import type { SystemState } from '@lance/db';
import type {
  AppendResult,
  LedgerEventRow,
  LedgerQuery,
  PauseResult,
  ResumeResult,
} from '@lance/ledger';
import type { Config, LedgerEventInputCandidate } from '@lance/shared';
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

export interface ApiDeps {
  config: Config;
  control: SystemControlLike;
  ledger: LedgerReaderLike;
  writer: LedgerWriterLike;
  status: StatusSource;
  auth: TokenVerifier;
  slack: SlackDeps;
  /** Shared secret for `POST /ingest/agent-log` (spec 7.1, agent-logs). */
  ingestSecret: string;
  /** Injected in tests. Returns an ISO-8601 instant with an explicit offset. */
  now?: () => string;
}

/** The ledger actor for everything Dom triggers, in Slack or in the api. */
export const DOM_ACTOR = 'user:dom';
