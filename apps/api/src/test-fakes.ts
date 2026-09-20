import type { SystemState } from '@lance/db';
import type { LedgerEventRow, LedgerQuery, PauseResult, ResumeResult } from '@lance/ledger';
import { loadConfig, newUlid, type Config, type LedgerEventInputCandidate } from '@lance/shared';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type {
  ApiDeps,
  LedgerReaderLike,
  LedgerWriterLike,
  SystemControlLike,
  TokenVerifier,
} from './deps.js';
import { UnauthorisedError } from './errors.js';
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
  now?: () => string;
}

export interface FakeDeps {
  deps: ApiDeps;
  control: FakeSystemControl;
  ledger: FakeLedgerReader;
  writer: FakeLedgerWriter;
  status: FakeStatusSource;
}

export const fakeDeps = (overrides: FakeDepsOverrides = {}): FakeDeps => {
  const control = new FakeSystemControl();
  const ledger = new FakeLedgerReader();
  const writer = new FakeLedgerWriter();
  const status = new FakeStatusSource();

  const deps: ApiDeps = {
    config: overrides.config ?? testConfig(),
    control: overrides.control ?? control,
    ledger: overrides.ledger ?? ledger,
    writer: overrides.writer ?? writer,
    status: overrides.status ?? status,
    auth: overrides.auth ?? fakeVerifier('good-token'),
    slack: {
      signingSecret: TEST_SIGNING_SECRET,
      allowedUserId:
        overrides.allowedSlackUserId === undefined
          ? TEST_SLACK_USER_ID
          : overrides.allowedSlackUserId,
    },
    ingestSecret: TEST_INGEST_SECRET,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };

  return { deps, control, ledger, writer, status };
};
