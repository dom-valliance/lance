import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  createGraphConnector,
  createGraphReads,
  createNotionConnector,
  createSlackSurface,
} from '@lance/connectors';
import {
  SEED_PRINCIPAL_ID,
  createDb,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  type Db,
  type Principal,
} from '@lance/db';
import { POSTGRES_TEST_IMAGE, openWorkerTestDb } from '@lance/db/testing';
import { loadConfig, newUlid, type Config } from '@lance/shared';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { graphExecutionWriters, notionExecutionWriters } from '../executor/writers.js';
import { bootWorker, type BootedWorker } from '../jobs/boot.js';
import { principalJobOptions } from '../jobs/scoped.js';
import type { ConnectorBundle, ConnectorLookup } from '../jobs/connectors.js';
import { ensureSeedRules } from '../policy/rules.js';
import { BOSS_SCHEMA } from '../scheduler/boss.js';
import { GRAPH_CALENDAR_WATCHER_NAME, GRAPH_MAIL_WATCHER_NAME } from '../watchers/graph/index.js';
import { JAMIE_WATCHER_NAME } from '../watchers/jamie/index.js';
import { NOTION_WATCHER_NAME } from '../watchers/notion/index.js';
import { watcherQueue } from '../watchers/runner.js';
import { dueBetween, nextMondayAt, virtualClock, type ScheduleRow } from './cron.js';
import { LatencyModelRunner, modelCallScope } from './fakeModel.js';
import {
  SlackRecorder,
  buildMailbox,
  buildNotionDatabase,
  editForMonday,
  graphFetch,
  jamieReads,
  loadPrincipals,
  notionFetch,
  type ConnectorLatency,
  type LoadPrincipal,
  type MorningShape,
  type World,
} from './fixtures.js';
import { seededRandom } from './random.js';
import { percentile, seconds, summarise, type Summary } from './stats.js';

/**
 * The load test (docs/runbooks/load-test.md, docs/plans/multi-user.md M8):
 * thirty synthetic principals on the real worker boot path, over one local
 * Postgres, with fixture connectors and a model runner that takes as long
 * as Anthropic does. Run it with `pnpm --filter @lance/worker load`; it is
 * not part of `pnpm test`.
 *
 * Every knob is an environment variable, read once below, and the worker's
 * own settings (MODEL_CONCURRENCY and the rest) are read by `loadConfig`
 * from the same environment, so a run at the defaults sets nothing.
 */

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};
const num = (name: string, fallback: number): number => {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
};

const SETTINGS = {
  principals: num('LOAD_PRINCIPALS', 30),
  seed: num('LOAD_SEED', 20260924),
  modelLatency: { min: num('LOAD_MODEL_MIN_MS', 3000), max: num('LOAD_MODEL_MAX_MS', 8000) },
  shape: {
    unreadMessages: num('LOAD_UNREAD', 40),
    meetings: num('LOAD_MEETINGS', 6),
    jamieMeetings: num('LOAD_JAMIE_MEETINGS', 3),
  } satisfies MorningShape,
  notionTasksPerPrincipal: num('LOAD_NOTION_TASKS', 5),
  taskCandidateRate: num('LOAD_TASK_RATE', 0.15),
  /** Also poll every principal's mail, calendar and Jamie at 06:30, where the brief falls. */
  alignWatchers: env('LOAD_ALIGN_WATCHERS', '1') === '1',
  maxMinutes: num('LOAD_MAX_MINUTES', 60),
  out: env('LOAD_OUT', join(tmpdir(), 'lance-load')),
  label: env('LOAD_LABEL', 'run'),
};

const CONNECTOR_LATENCY: ConnectorLatency = {
  graph: { min: 80, max: 250 },
  notion: { min: 150, max: 400 },
  jamie: { min: 150, max: 400 },
  slack: { min: 80, max: 200 },
};

const TIME_ZONE = 'Europe/London';
const BRIEF_TARGET_MS = 5 * 60_000;
const QUEUE_P95_TARGET_MS = 60_000;
const ALIGNED_WATCHERS = [GRAPH_MAIL_WATCHER_NAME, GRAPH_CALENDAR_WATCHER_NAME, JAMIE_WATCHER_NAME];
const WARM_WATCHERS = [...ALIGNED_WATCHERS, NOTION_WATCHER_NAME];
/** Queues that fire every minute whatever the load; the run is idle when nothing else is queued. */
const EVERY_MINUTE = new Set([
  'jobs-reconcile',
  'onboarding-prefill',
  'alerts-deliver',
  '__pgboss__send-it',
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ logging

mkdirSync(SETTINGS.out, { recursive: true });
const logPath = join(SETTINGS.out, `${SETTINGS.label}.worker.log`);
const workerLog = createWriteStream(logPath);
let jobFailures = 0;
const say = (message: string): void => {
  process.stdout.write(`[load ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
};
/** The worker's own log lines go to a file; the harness keeps the terminal. */
function captureWorkerLog(): void {
  const levels = ['debug', 'info', 'warn', 'error'] as const;
  const writer =
    (level: (typeof levels)[number]) =>
    (...args: unknown[]): void => {
      if (level === 'error' && args[1] === 'job failed') jobFailures += 1;
      const line = args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg, errorReplacer)))
        .join(' ');
      workerLog.write(`${new Date().toISOString()} ${level} ${line}\n`);
    };
  Object.assign(console, Object.fromEntries(levels.map((level) => [level, writer(level)])));
}
function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? `${value.name}: ${value.message}` : value;
}

// ------------------------------------------------------------ database

interface Database {
  container: StartedPostgreSqlContainer;
  url: string;
  fixture: Db;
  root: Db;
}

/**
 * Docker sometimes fails the local image lookup and tries to pull
 * `lance-postgres`, which is in no registry; `startPostgresContainer` in
 * `@lance/db/testing` retries for the same reason. This start differs only
 * in loading pg_stat_statements.
 */
async function startContainer(attempts = 3): Promise<StartedPostgreSqlContainer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await new PostgreSqlContainer(POSTGRES_TEST_IMAGE)
        .withDatabase('lance')
        .withUsername('postgres')
        .withPassword('postgres')
        .withCommand([
          'postgres',
          '-c',
          'shared_preload_libraries=age,pg_stat_statements',
          '-c',
          'pg_stat_statements.track=all',
          '-c',
          'max_connections=200',
        ])
        .start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !/pull access denied|404|EOF|socket hang up/i.test(message))
        throw error;
      await sleep(2000 * attempt);
    }
  }
}

async function startDatabase(): Promise<Database> {
  say(`starting ${POSTGRES_TEST_IMAGE} with pg_stat_statements`);
  const container = await startContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  const fixture = createDb({ connectionString: url, password: 'postgres' });
  await fixture.$client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  // The worker's login: a lance_app member with the retention grant, and
  // pg's default pool of ten, as the worker has in Azure.
  const root = await openWorkerTestDb(url);
  return { container, url, fixture, root };
}

async function createPrincipals(db: Database, list: readonly LoadPrincipal[]): Promise<void> {
  for (const principal of list) {
    if (principal.id === SEED_PRINCIPAL_ID) {
      await db.fixture.$client.query(
        'UPDATE principals SET slack_channel_id = $2, notion_user_id = $3 WHERE id = $1',
        [principal.id, principal.slackChannelId, principal.notionUserId],
      );
      continue;
    }
    await db.fixture.$client.query(
      `INSERT INTO principals (id, upn, time_zone, status, slack_channel_id, notion_user_id)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [principal.id, principal.upn, TIME_ZONE, principal.slackChannelId, principal.notionUserId],
    );
    await scopedDb(db.fixture, { principalId: principal.id })
      .insert(principalState)
      .values({})
      .onConflictDoNothing({ target: principalState.principalId });
  }
  // docs/plans/multi-user.md M5: the admin sets the organisation ceiling to
  // the per-principal default times the principals. Left at its single-user
  // default of GBP 15, thirty principals' morning would be refused part way.
  await db.fixture.$client.query('UPDATE system_state SET cost_ceiling_gbp = $1 WHERE id = 1', [
    15 * list.length,
  ]);
}

// ------------------------------------------------------------ connectors

interface Fixtures {
  world: World;
  slack: SlackRecorder;
  connectorsFor: ConnectorLookup;
  mondayNotionEdit: () => void;
}

function buildFixtures(config: Config, list: readonly LoadPrincipal[], now: Date): Fixtures {
  const world: World = { phase: 'warm' };
  const random = seededRandom(SETTINGS.seed);
  const slack = new SlackRecorder(seededRandom(SETTINGS.seed + 1), CONNECTOR_LATENCY.slack);
  const notionDb = buildNotionDatabase(list, SETTINGS.notionTasksPerPrincipal, now);
  const byId = new Map(list.map((principal) => [principal.id, principal]));
  const connectorsFor: ConnectorLookup = (principal: Principal) => {
    const fixture = byId.get(principal.id);
    if (fixture === undefined) return Promise.resolve(null);
    const mailbox = buildMailbox(fixture, list, SETTINGS.shape, random, now);
    const graph = createGraphConnector({
      accessToken: () => Promise.resolve('load-test-token'),
      fetchImpl: graphFetch(world, mailbox, random, CONNECTOR_LATENCY.graph),
    });
    const reads = createGraphReads(graph);
    const notion = createNotionConnector({
      token: 'load-test-notion-token',
      fetchImpl: notionFetch(notionDb, random, CONNECTOR_LATENCY.notion),
    });
    const bundle: ConnectorBundle = {
      graph: { reads, writers: graphExecutionWriters(graph, reads) },
      notion: {
        connector: notion,
        writers: notionExecutionWriters(notion, config),
        principalUserId: fixture.notionUserId,
      },
      jamie: jamieReads(world, fixture, SETTINGS.shape, random, CONNECTOR_LATENCY.jamie, now),
      slack: createSlackSurface({
        token: 'xoxb-load-test',
        channelId: fixture.slackChannelId,
        fetchImpl: slack.fetch,
      }),
      // The agent-logs watcher reads Slack channel history and App Insights,
      // neither of which has a fixture; it is off for everyone, as it is
      // for a principal without a bot token.
      agentLogs: null,
      notConnected: [],
    };
    return Promise.resolve(bundle);
  };
  return {
    world,
    slack,
    connectorsFor,
    mondayNotionEdit: () => {
      editForMonday(notionDb, SETTINGS.notionTasksPerPrincipal, new Date());
    },
  };
}

// ------------------------------------------------------------ limiter

interface LimiterWait {
  principalId: string;
  askedAt: number;
  admittedAt: number;
}

interface InstrumentedLimiter {
  waits: LimiterWait[];
  /**
   * While true, model runs skip the fair-share limiter. Only the warm-up
   * sets it: the Friday's history is set-up, not load, and through the
   * per-principal token bucket it would take half an hour to read.
   */
  bypass: boolean;
}

/**
 * Wraps each principal's `limit` so every model run records when it asked
 * for a slot and when the fair-share limiter let it in, and so the model
 * runner knows whose call it is serving.
 */
async function instrumentLimiter(
  worker: BootedWorker,
  ids: readonly string[],
): Promise<InstrumentedLimiter> {
  const instrumented: InstrumentedLimiter = { waits: [], bypass: false };
  for (const principalId of ids) {
    const resolution = await worker.contexts.resolve(principalId);
    if (resolution.status !== 'active') continue;
    const agent = resolution.context.agent;
    const limit = agent?.limit;
    if (agent === null || limit === undefined) continue;
    agent.limit = <T>(work: () => Promise<T>): Promise<T> => {
      const scoped = (): Promise<T> => modelCallScope.run({ principalId }, work);
      if (instrumented.bypass) return scoped();
      const askedAt = Date.now();
      return limit(() => {
        instrumented.waits.push({ principalId, askedAt, admittedAt: Date.now() });
        return scoped();
      });
    };
  }
  return instrumented;
}

// ------------------------------------------------------------ sampling

interface Sample {
  at: number;
  active: number;
  total: number;
  poolTotal: number;
  poolWaiting: number;
}

interface ProcessLoad {
  /** Worker process CPU over the window, as a share of one core. */
  cpuCoreShare: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
  rssPeakMb: number;
}

function startSampler(db: Database): {
  samples: Sample[];
  stop: () => ProcessLoad;
} {
  const samples: Sample[] = [];
  const pool = db.root.$client.base;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const cpuStart = process.cpuUsage();
  const wallStart = Date.now();
  let rssPeak = 0;
  const timer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    void db.fixture.$client
      .query(
        `SELECT count(*) FILTER (WHERE state = 'active')::int AS active, count(*)::int AS total
           FROM pg_stat_activity WHERE datname = 'lance' AND pid <> pg_backend_pid()`,
      )
      .then((result) => {
        const row = (result.rows as { active: number; total: number }[])[0];
        samples.push({
          at: Date.now(),
          // The sampler's own session is idle while it reads; the counted
          // active sessions are the worker's.
          active: row?.active ?? 0,
          total: row?.total ?? 0,
          poolTotal: pool.totalCount,
          poolWaiting: pool.waitingCount,
        });
      })
      .catch(() => undefined);
  }, 1000);
  return {
    samples,
    stop: () => {
      clearInterval(timer);
      loop.disable();
      const cpu = process.cpuUsage(cpuStart);
      return {
        cpuCoreShare: (cpu.user + cpu.system) / 1000 / Math.max(1, Date.now() - wallStart),
        eventLoopDelayP99Ms: loop.percentile(99) / 1e6,
        eventLoopDelayMaxMs: loop.max / 1e6,
        rssPeakMb: rssPeak / 1024 / 1024,
      };
    },
  };
}

async function pendingJobs(db: Database, since: Date | null): Promise<Record<string, number>> {
  const result = await db.fixture.$client.query(
    `SELECT name, count(*)::int AS n FROM ${BOSS_SCHEMA}.job
      WHERE state IN ('created', 'retry', 'active') AND ($1::timestamptz IS NULL OR created_on >= $1)
        AND start_after <= now()
      GROUP BY name`,
    [since],
  );
  return Object.fromEntries(
    (result.rows as { name: string; n: number }[]).map((row) => [row.name, row.n]),
  );
}

async function waitForIdle(db: Database, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const pending = await pendingJobs(db, null);
    const busy = Object.entries(pending).filter(([name]) => !EVERY_MINUTE.has(name));
    if (busy.length === 0) return;
    const summary = busy.map(([name, n]) => `${name}=${String(n)}`).join(' ');
    if (summary !== last) say(`${what}: waiting on ${summary}`);
    last = summary;
    await sleep(2000);
  }
  throw new Error(`${what} did not drain within ${seconds(timeoutMs)}; see ${logPath}.`);
}

// ------------------------------------------------------------ the window

interface WindowResult {
  t0Real: number;
  startReal: number;
  endReal: number;
  virtualStart: Date;
  sent: number;
}

async function runWindow(
  db: Database,
  boss: PgBoss,
  fixtures: Fixtures,
  list: readonly LoadPrincipal[],
  model: LatencyModelRunner,
): Promise<WindowResult> {
  const startReal = Date.now();
  const opening = nextMondayAt('06:30', TIME_ZONE, new Date(startReal));
  const virtualStart = new Date(opening.getTime() - 60_000);
  const clock = virtualClock(virtualStart, startReal);
  const t0Real = clock.realOf(opening);
  say(
    `window opens: virtual ${virtualStart.toISOString()} is now; 06:30 London falls at real ${new Date(t0Real).toISOString()}`,
  );
  fixtures.world.phase = 'monday';
  fixtures.mondayNotionEdit();
  model.setLatency(SETTINGS.modelLatency);
  await db.fixture.$client.query('SELECT pg_stat_statements_reset()');

  let schedules: ScheduleRow[] = await boss.getSchedules();
  let schedulesReadAt = Date.now();
  let last = virtualStart;
  let aligned = false;
  let sent = 0;
  let idleSince: number | null = null;
  const deadline = startReal + SETTINGS.maxMinutes * 60_000;

  while (Date.now() < deadline) {
    const now = new Date(clock.now());
    if (Date.now() - schedulesReadAt > 60_000) {
      schedules = await boss.getSchedules();
      schedulesReadAt = Date.now();
    }
    const fired = new Set<string>();
    for (const due of dueBetween(schedules, last, now)) {
      // The schedule's group, as pg-boss's own cron would send it, so a
      // principal's jobs on a queue never overlap here either.
      const group = due.schedule.options?.group;
      await boss.send(due.schedule.name, due.schedule.data ?? {}, group ? { group } : {});
      const principalId = (due.schedule.data as { principalId?: string } | null)?.principalId;
      fired.add(`${due.schedule.name}|${principalId ?? ''}`);
      sent += 1;
    }
    if (!aligned && now >= opening) {
      aligned = true;
      if (SETTINGS.alignWatchers) {
        // Only the polls the schedule does not already put at 06:30: the
        // calendar and Jamie fall due every fifteen minutes, mail at 06:00
        // and 07:00, so this adds the mail poll alone.
        for (const principal of list) {
          for (const name of ALIGNED_WATCHERS) {
            const queue = watcherQueue({ name });
            if (fired.has(`${queue}|${principal.id}`)) continue;
            await boss.send(
              queue,
              { principalId: principal.id },
              principalJobOptions(principal.id),
            );
            sent += 1;
          }
        }
      }
      say(`06:30: ${String(sent)} jobs sent so far`);
    }
    last = now;

    if (aligned && Date.now() - t0Real > BRIEF_TARGET_MS) {
      const posted = await briefsPosted(db, fixtures, list, t0Real);
      const pending = Object.entries(await pendingJobs(db, null)).filter(
        ([name]) => !EVERY_MINUTE.has(name),
      );
      if (posted === list.length && pending.length === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince > 30_000) break;
      } else {
        idleSince = null;
      }
      if ((Date.now() - startReal) % 60_000 < 1000) {
        say(
          `virtual ${now.toISOString().slice(11, 16)} UTC: ${String(posted)}/${String(list.length)} briefs posted; queued ${pending.map(([name, n]) => `${name}=${String(n)}`).join(' ') || 'nothing'}`,
        );
      }
    }
    await sleep(1000);
  }
  return { t0Real, startReal, endReal: Date.now(), virtualStart, sent };
}

async function briefsPosted(
  db: Database,
  fixtures: Fixtures,
  list: readonly LoadPrincipal[],
  since: number,
): Promise<number> {
  const rows = await morningBriefs(db, since);
  const channels = new Set(
    fixtures.slack.posts.filter((post) => post.threadTs === null).map((post) => post.ts),
  );
  return list.filter((principal) => {
    const row = rows.get(principal.id);
    return row !== undefined && row.slackTs !== null && channels.has(row.slackTs);
  }).length;
}

async function morningBriefs(
  db: Database,
  since: number,
): Promise<Map<string, { generatedAt: number; slackTs: string | null }>> {
  const result = await db.fixture.$client.query(
    `SELECT principal_id, generated_at, content ->> 'slackTs' AS slack_ts FROM briefs
      WHERE kind = 'morning_brief' AND generated_at >= $1 ORDER BY generated_at`,
    [new Date(since - 5 * 60_000)],
  );
  return new Map(
    (result.rows as { principal_id: string; generated_at: Date; slack_ts: string | null }[]).map(
      (row) => [
        row.principal_id,
        { generatedAt: row.generated_at.getTime(), slackTs: row.slack_ts },
      ],
    ),
  );
}

// ------------------------------------------------------------ report

interface QueueRow {
  name: string;
  state: string;
  retry_count: number;
  created_on: Date;
  start_after: Date;
  started_on: Date | null;
  completed_on: Date | null;
  output: unknown;
}

async function collect(
  db: Database,
  window: WindowResult,
  fixtures: Fixtures,
  list: readonly LoadPrincipal[],
  model: LatencyModelRunner,
  waits: readonly LimiterWait[],
  samples: readonly Sample[],
  config: Config,
): Promise<Record<string, unknown>> {
  const { t0Real, startReal } = window;
  const offset = (at: number): number => at - t0Real;
  const briefs = await morningBriefs(db, t0Real);
  const byTs = new Map(fixtures.slack.posts.map((post) => [post.ts, post]));
  const briefRows = list.map((principal) => {
    const row = briefs.get(principal.id);
    const parent = row?.slackTs === null || row === undefined ? undefined : byTs.get(row.slackTs);
    const replies = fixtures.slack.posts.filter(
      (post) => parent !== undefined && post.threadTs === parent.ts,
    );
    const lastPost = Math.max(parent?.at ?? 0, ...replies.map((post) => post.at));
    return {
      principal: principal.index + 1,
      storedMs: row === undefined ? null : offset(row.generatedAt),
      postedMs: parent === undefined ? null : offset(parent.at),
      threadDoneMs: parent === undefined ? null : offset(lastPost),
    };
  });
  const stored = briefRows.map((row) => row.storedMs).filter((v): v is number => v !== null);
  const posted = briefRows.map((row) => row.postedMs).filter((v): v is number => v !== null);

  // Queue latency: from when a job could first start to when a worker took it.
  const jobs = (
    await db.fixture.$client.query(
      `SELECT name, state, retry_count, created_on, start_after, started_on, completed_on, output
         FROM ${BOSS_SCHEMA}.job WHERE created_on >= $1 AND name NOT LIKE '\\_\\_pgboss%'`,
      [new Date(startReal)],
    )
  ).rows as QueueRow[];
  const byQueue = new Map<string, QueueRow[]>();
  for (const job of jobs) byQueue.set(job.name, [...(byQueue.get(job.name) ?? []), job]);
  const latencyOf = (job: QueueRow): number | null =>
    job.started_on === null
      ? null
      : job.started_on.getTime() - Math.max(job.created_on.getTime(), job.start_after.getTime());
  const unstarted = (job: QueueRow): number =>
    window.endReal - Math.max(job.created_on.getTime(), job.start_after.getTime());
  const queues = [...byQueue.entries()]
    .map(([name, rows]) => {
      // A job still waiting when the run ended counts at the time it had waited, so a
      // backlog cannot flatter the percentiles by never starting.
      const latencies = rows.map((job) => latencyOf(job) ?? unstarted(job));
      const runs = rows
        .filter((job) => job.started_on !== null && job.completed_on !== null)
        .map((job) => (job.completed_on?.getTime() ?? 0) - (job.started_on?.getTime() ?? 0));
      return {
        name,
        jobs: rows.length,
        unfinished: rows.filter((job) => job.completed_on === null).length,
        latency: summarise(latencies),
        run: summarise(runs),
      };
    })
    .sort((a, b) => b.latency.p95 - a.latency.p95);
  const allLatencies = jobs.map((job) => latencyOf(job) ?? unstarted(job));
  const failed = jobs.filter((job) => job.state === 'failed' || job.retry_count > 0);
  const failures = [...new Set(failed.map((job) => job.name))].map((name) => ({
    queue: name,
    jobs: failed.filter((job) => job.name === name).length,
    example: JSON.stringify(failed.find((job) => job.name === name)?.output ?? null).slice(0, 300),
  }));

  // Model calls and the limiter's shares.
  const calls = model.calls.filter((call) => call.startedAt >= startReal);
  const byAgent: Record<string, number> = {};
  for (const call of calls) byAgent[call.agent] = (byAgent[call.agent] ?? 0) + 1;
  const windowWaits = waits.filter((wait) => wait.askedAt >= startReal);
  const perPrincipal = list.map((principal) => {
    const mine = windowWaits.filter((wait) => wait.principalId === principal.id);
    const ms = mine.map((wait) => wait.admittedAt - wait.askedAt);
    return {
      principal: principal.index + 1,
      runs: mine.length,
      modelCalls: calls.filter((call) => call.principalId === principal.id).length,
      meanWaitMs: ms.length === 0 ? 0 : ms.reduce((a, b) => a + b, 0) / ms.length,
      p95WaitMs: percentile(ms, 95),
    };
  });
  const means = perPrincipal.map((row) => row.meanWaitMs);
  const worst = [...perPrincipal].sort((a, b) => b.meanWaitMs - a.meanWaitMs)[0];

  // Push budget: unsolicited posts per principal in the window.
  const pushes = (
    await db.fixture.$client.query(
      `SELECT principal_id, count(*)::int AS n FROM ledger_events
        WHERE kind = 'resolved' AND payload ->> 'kind' = 'slack_push' AND ts >= $1
        GROUP BY principal_id`,
      [new Date(startReal)],
    )
  ).rows as { principal_id: string; n: number }[];
  const budgets = (
    await db.fixture.$client.query('SELECT principal_id, push_budget_per_hour FROM principal_state')
  ).rows as { principal_id: string; push_budget_per_hour: number }[];
  // Briefs, boards, preps and debriefs are exempt from the push budget
  // (spec 9.4); each records its Slack ts in the ledger when it posts.
  const exempt = (
    await db.fixture.$client.query(
      `SELECT payload ->> 'slackTs' AS ts FROM ledger_events
        WHERE kind = 'resolved' AND payload ->> 'kind' IN ('brief', 'debrief') AND ts >= $1`,
      [new Date(startReal)],
    )
  ).rows as { ts: string | null }[];
  const briefParents = new Set([
    ...[...briefs.values()].map((row) => row.slackTs),
    ...exempt.map((row) => row.ts),
  ]);
  const unsolicited = list.map((principal) => {
    const topLevel = fixtures.slack.posts.filter(
      (post) =>
        post.channel === principal.slackChannelId &&
        post.threadTs === null &&
        post.at >= startReal &&
        !briefParents.has(post.ts),
    ).length;
    return {
      principal: principal.index + 1,
      recordedPushes: pushes.find((row) => row.principal_id === principal.id)?.n ?? 0,
      unsolicitedPosts: topLevel,
      budgetPerHour:
        budgets.find((row) => row.principal_id === principal.id)?.push_budget_per_hour ?? 3,
    };
  });

  const statements = (
    await db.fixture.$client.query(
      `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query, calls::int,
              round(total_exec_time)::int AS total_ms, round(mean_exec_time::numeric, 2)::float AS mean_ms,
              round(max_exec_time::numeric, 1)::float AS max_ms
         FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'lance')
        ORDER BY total_exec_time DESC LIMIT 15`,
    )
  ).rows;
  const slowest = (
    await db.fixture.$client.query(
      `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query, calls::int,
              round(mean_exec_time::numeric, 2)::float AS mean_ms, round(max_exec_time::numeric, 1)::float AS max_ms
         FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'lance') AND calls >= 5
        ORDER BY mean_exec_time DESC LIMIT 10`,
    )
  ).rows;
  const windowSamples = samples.filter((sample) => sample.at >= startReal);

  const brief: Summary = summarise(stored);
  const queueP95 = percentile(allLatencies, 95);
  const maxPushes = Math.max(0, ...unsolicited.map((row) => row.unsolicitedPosts));
  return {
    label: SETTINGS.label,
    settings: {
      ...SETTINGS,
      modelConcurrency: config.modelLimiter.concurrency,
      principalBurst: config.modelLimiter.principalBurst,
      principalRunsPerMinute: config.modelLimiter.principalRunsPerMinute,
    },
    durationMs: window.endReal - startReal,
    jobsSentByClock: window.sent,
    verdicts: {
      briefsStoredBy0635: {
        target: 'all stored within 5 minutes of 06:30',
        stored: stored.length,
        withinTarget: stored.filter((ms) => ms <= BRIEF_TARGET_MS).length,
        pass: stored.length === list.length && brief.max <= BRIEF_TARGET_MS,
      },
      briefsPosted: {
        posted: posted.length,
        pushBudgetMaxUsed: maxPushes,
        pass:
          posted.length === list.length &&
          unsolicited.every((row) => row.unsolicitedPosts <= row.budgetPerHour),
      },
      queueLatencyP95: {
        targetMs: QUEUE_P95_TARGET_MS,
        p95Ms: queueP95,
        pass: queueP95 < QUEUE_P95_TARGET_MS,
      },
    },
    briefs: { stored: brief, posted: summarise(posted), perPrincipal: briefRows },
    queues,
    allQueues: summarise(allLatencies),
    failures,
    workerJobFailedLogLines: jobFailures,
    model: {
      calls: calls.length,
      runs: windowWaits.length,
      byAgent,
      medianPrincipalMeanWaitMs: percentile(means, 50),
      worstPrincipal: worst,
      perPrincipal,
    },
    pushBudget: unsolicited,
    postgres: {
      activeConnectionsPeak: Math.max(0, ...windowSamples.map((sample) => sample.active)),
      connectionsPeak: Math.max(0, ...windowSamples.map((sample) => sample.total)),
      workerPoolPeak: Math.max(0, ...windowSamples.map((sample) => sample.poolTotal)),
      workerPoolWaitingPeak: Math.max(0, ...windowSamples.map((sample) => sample.poolWaiting)),
      workerPoolWaitingMean:
        windowSamples.length === 0
          ? 0
          : windowSamples.reduce((sum, sample) => sum + sample.poolWaiting, 0) /
            windowSamples.length,
      topByTotalTime: statements,
      slowestByMean: slowest,
    },
  };
}

function printSummary(report: Record<string, unknown>): void {
  const r = report as {
    verdicts: Record<string, { pass: boolean }>;
    briefs: { stored: Summary; posted: Summary };
    allQueues: Summary;
    queues: { name: string; jobs: number; unfinished: number; latency: Summary; run: Summary }[];
    model: {
      calls: number;
      runs: number;
      byAgent: Record<string, number>;
      medianPrincipalMeanWaitMs: number;
      worstPrincipal?: { principal: number; meanWaitMs: number };
    };
    failures: unknown[];
    postgres: {
      activeConnectionsPeak: number;
      connectionsPeak: number;
      workerPoolWaitingPeak: number;
      workerPoolWaitingMean: number;
    };
    durationMs: number;
  };
  say(`run took ${seconds(r.durationMs)}`);
  say(
    `briefs stored after 06:30: p50 ${seconds(r.briefs.stored.p50)}, max ${seconds(r.briefs.stored.max)} (${String(r.briefs.stored.count)})`,
  );
  say(
    `briefs posted after 06:30: p50 ${seconds(r.briefs.posted.p50)}, max ${seconds(r.briefs.posted.max)} (${String(r.briefs.posted.count)})`,
  );
  say(
    `queue latency all: p50 ${seconds(r.allQueues.p50)} p95 ${seconds(r.allQueues.p95)} p99 ${seconds(r.allQueues.p99)}`,
  );
  for (const queue of r.queues.slice(0, 12)) {
    say(
      `  ${queue.name.padEnd(34)} jobs ${String(queue.jobs).padStart(5)} unfinished ${String(queue.unfinished).padStart(4)} p50 ${seconds(queue.latency.p50).padStart(9)} p95 ${seconds(queue.latency.p95).padStart(9)} p99 ${seconds(queue.latency.p99).padStart(9)} run p50 ${seconds(queue.run.p50)}`,
    );
  }
  say(
    `model: ${String(r.model.calls)} calls in ${String(r.model.runs)} runs ${JSON.stringify(r.model.byAgent)}; wait median ${seconds(r.model.medianPrincipalMeanWaitMs)}, worst principal ${String(r.model.worstPrincipal?.principal)} at ${seconds(r.model.worstPrincipal?.meanWaitMs ?? 0)}`,
  );
  say(
    `postgres: active peak ${String(r.postgres.activeConnectionsPeak)}, connections peak ${String(r.postgres.connectionsPeak)}, pool waiting peak ${String(r.postgres.workerPoolWaitingPeak)} mean ${r.postgres.workerPoolWaitingMean.toFixed(2)}`,
  );
  say(`failures: ${JSON.stringify(r.failures)}`);
  say(`verdicts: ${JSON.stringify(r.verdicts)}`);
}

// ------------------------------------------------------------ main

async function main(): Promise<void> {
  const started = Date.now();
  const db = await startDatabase();
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    DOM_EMAIL: 'dom@valliance.ai',
  });
  const [admin] = await db.fixture
    .select()
    .from(principals)
    .where(eq(principals.id, SEED_PRINCIPAL_ID));
  if (admin === undefined) throw new Error('The seed did not create the first principal.');
  const list = loadPrincipals(
    SETTINGS.principals,
    { id: admin.id, upn: admin.upn, notionUserId: admin.notionUserId ?? '' },
    () => newUlid(),
  );
  await createPrincipals(db, list);
  await ensureSeedRules(
    scopedDb(db.root, { principalId: admin.id, admin: true }),
    config.slack.channelId,
  );

  const now = new Date();
  const fixtures = buildFixtures(config, list, now);
  const model = new LatencyModelRunner({
    random: seededRandom(SETTINGS.seed + 2),
    latencyMs: { min: 0, max: 0 },
    output: { taskCandidateRate: SETTINGS.taskCandidateRate },
  });

  captureWorkerLog();
  // The worker's pg-boss, as `createBoss` builds it, with pg-boss's own
  // cron off: the harness's virtual clock decides when schedules fall due.
  const pool = db.root.$client;
  const boss = new PgBoss({
    schema: BOSS_SCHEMA,
    db: { executeSql: (text: string, values?: unknown[]) => pool.query(text, values) },
    schedule: false,
  });
  boss.on('error', (error: Error) => {
    console.error({ err: error }, 'pg-boss error');
  });
  say(`booting the worker for ${String(list.length)} principals`);
  const worker = await bootWorker({
    config,
    root: db.root,
    boss,
    modelRunner: model,
    connectorsFor: fixtures.connectorsFor,
    webUrl: null,
    roleCheckCredentials: null,
  });
  say(`booted: ${JSON.stringify(worker.initial)}`);
  const limiter = await instrumentLimiter(
    worker,
    list.map((principal) => principal.id),
  );

  say('warm-up: the Friday polls, with an instant model and no limiter');
  limiter.bypass = true;
  for (const principal of list) {
    for (const name of WARM_WATCHERS) {
      await boss.send(
        watcherQueue({ name }),
        { principalId: principal.id },
        principalJobOptions(principal.id),
      );
    }
  }
  await waitForIdle(db, 20 * 60_000, 'warm-up');
  limiter.bypass = false;
  say(`warm-up drained in ${seconds(Date.now() - started)} since start`);

  const sampler = startSampler(db);
  const window = await runWindow(db, boss, fixtures, list, model);
  const processLoad = sampler.stop();
  const report = await collect(
    db,
    window,
    fixtures,
    list,
    model,
    limiter.waits,
    sampler.samples,
    config,
  );
  report['process'] = processLoad;
  const reportPath = join(SETTINGS.out, `${SETTINGS.label}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);
  say(`process: ${JSON.stringify(processLoad)}`);
  say(`report: ${reportPath}; worker log: ${logPath}`);

  await boss.stop({ graceful: false });
  await db.root.$client.end();
  await db.fixture.$client.end();
  await db.container.stop();
  workerLog.end();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `load test failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
