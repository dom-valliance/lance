import { z } from 'zod';
import { MailLabelSchema, SystemModeSchema, type MailLabel, type SystemMode } from './enums.js';

/**
 * Config loader. Reads `process.env` (or an injected env object, for tests)
 * once, validates every value, and returns a fully typed, immutable
 * `Config`. Never logs a value: on failure it throws one error naming every
 * invalid environment variable and why, never the value supplied.
 *
 * Model ids and effort live here, never in code (ADR 0002). Where the spec
 * (or CLAUDE.md) does not name an environment variable explicitly, this
 * file picks the obvious `UPPER_SNAKE_CASE` name and says so in a comment.
 */

/**
 * Model "effort" level. Not one of the domain enums in `enums.ts` (that
 * file is exactly the named list from the work package); scoped to config
 * because it only ever appears on a `ModelConfig`.
 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

export interface ModelConfig {
  id: string;
  effort: Effort;
}

const PriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
});
export type Price = z.infer<typeof PriceSchema>;

const PriceTableSchema = z.record(z.string(), PriceSchema);
export type PriceTable = z.infer<typeof PriceTableSchema>;

const HhMmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in 24-hour time');

const TimeZoneSchema = z.string().min(1).refine(isValidTimeZone, 'valid IANA time zone name');

function isValidTimeZone(timeZone: string): boolean {
  try {
    // Constructed only to trigger its RangeError on an invalid zone name.
    void new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  agentDisplayName: string;
  mode: SystemMode;
  timeZone: string;
  database: {
    /** Required outside production; production reaches Postgres via the Entra token from ADR 0008, handled in `@lance/db`. */
    url: string | undefined;
    /**
     * How long an app waits at start-up for the migration job to create
     * its principal before giving up (ADR 0032). Default 600 seconds.
     */
    startupWaitSeconds: number;
  };
  models: {
    planner: ModelConfig;
    critic: ModelConfig;
    criticDraft: ModelConfig;
    triage: ModelConfig;
    label: ModelConfig;
  };
  anthropic: {
    baseUrl: string | undefined;
  };
  /** USD, keyed by model id. Estimates for cost reporting only: Anthropic's console is authoritative. */
  prices: PriceTable;
  cost: {
    dailyCeilingGbp: number;
    /** Refresh periodically; not a live FX feed. */
    usdToGbp: number;
  };
  scheduler: {
    tickSeconds: number;
  };
  /**
   * The per-process model limiter (docs/plans/multi-user.md M5): every
   * model run waits for one of `concurrency` slots, shared by every
   * principal, and each principal draws from their own token bucket of
   * `principalBurst` runs refilled at `principalRunsPerMinute`. Slots go to
   * waiting principals in turn, so one principal's backfill cannot starve
   * another's morning brief.
   */
  modelLimiter: {
    concurrency: number;
    principalBurst: number;
    principalRunsPerMinute: number;
  };
  proposals: {
    expiryHours: number;
  };
  interruption: {
    quietHoursStart: string;
    quietHoursEnd: string;
    pushBudgetPerHour: number;
  };
  promotion: {
    threshold: number;
    minSpanDays: number;
  };
  watchers: {
    dryRunDaysForNewWatcher: number;
  };
  inboxAgent: {
    /**
     * Whether the agent-logs watcher alerts on a stale inbox agent
     * watermark. Off by default since Dom's inbox agent stopped posting its
     * digest to Slack on 2026-09-23 (Phase 1: its posting retired in favour
     * of Lance), which left the watermark with nothing to read.
     */
    watermarkAlert: boolean;
    watermarkMaxAgeHours: number;
  };
  triage: {
    /**
     * ADR 0034: a mail observation whose labels all fall in this set skips
     * model triage and is filed by deterministic code under the seed rules.
     * Default `Newsletters` and `Notifications`, the labels seed rules 3
     * and 4 file automatically.
     */
    bulkLabels: readonly MailLabel[];
  };
  /**
   * The queues whose jobs wait on the model: `watcher-graph-mail` and
   * `triage` (load-test option A, ADR 0034). `concurrency` is how many of
   * each queue's jobs one worker runs at once; a principal never has more
   * than one in flight on either.
   */
  modelQueues: {
    concurrency: number;
  };
  briefs: {
    minFreeBlockHours: number;
  };
  retention: {
    mailBodiesDays: number;
    transcriptsDays: number;
    ledgerDays: number;
    modelLogsDays: number;
  };
  offboarding: {
    /**
     * Days a principal paused by the nightly role check may go on holding
     * no Lance role before the check offboards them (package 5.6). The
     * first night only pauses, so a mistaken group change costs nothing.
     */
    afterRoleLossDays: number;
  };
  featureFlags: {
    graphWrites: boolean;
    notionWrites: boolean;
    slackWrites: boolean;
  };
  slack: {
    channelId: string;
  };
  /** Who Lance works for, as the systems name him. Identifiers, not secrets. */
  dom: {
    name: string;
    email: string;
  };
  notion: {
    tasksDataSourceId: string;
    tasksDatabaseId: string;
    /** Null when the Meetings database is not watched (spec 16 Q7: All Tasks only in dev; add the Meetings data source id to watch it). */
    meetingsDataSourceId: string | null;
    domUserId: string;
    permittedTaskProperties: readonly string[];
  };
}

const DEFAULT_PERMITTED_TASK_PROPERTIES = [
  'Title',
  'Status',
  'Assignee',
  'Contributors',
  'Due',
  'Priority',
  'Project',
  'Type',
  'Sub-type',
  'Description',
  'Notes',
] as const;

const DEFAULT_PRICES: PriceTable = {
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
};

interface ConfigError {
  variable: string;
  reason: string;
}

/**
 * Reads `name` from `env`, treating an unset or empty-string variable as
 * "not provided" so the default applies.
 */
function raw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reads and validates one environment variable. Missing means "use
 * `defaultValue}`"; present but invalid records `reason` against `name` in
 * `errors` and still falls back to `defaultValue` so the caller can keep
 * assembling the rest of the config and report every problem at once.
 */
function readField<T>(
  errors: ConfigError[],
  env: NodeJS.ProcessEnv,
  name: string,
  schema: z.ZodType<T>,
  defaultValue: T,
  reason: string,
  transform: (value: string) => unknown = (value) => value,
): T {
  const value = raw(env, name);
  if (value === undefined) {
    return defaultValue;
  }
  const result = schema.safeParse(transform(value));
  if (!result.success) {
    errors.push({ variable: name, reason });
    return defaultValue;
  }
  return result.data;
}

function toNumber(value: string): unknown {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}

/** Accepts "true"/"1" and "false"/"0", case-insensitively, per the work package's documented boolean format. */
function toBoolean(value: string): unknown {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  return value;
}

function toCommaList(value: string): unknown {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readModel(
  errors: ConfigError[],
  env: NodeJS.ProcessEnv,
  idVar: string,
  effortVar: string,
  defaultId: string,
  defaultEffort: Effort,
): ModelConfig {
  return {
    id: readField(errors, env, idVar, z.string().min(1), defaultId, 'must be a non-empty model id'),
    effort: readField(
      errors,
      env,
      effortVar,
      EffortSchema,
      defaultEffort,
      `must be one of: ${EFFORTS.join(', ')}`,
    ),
  };
}

/**
 * Builds and validates the config from `env` (defaulting to `process.env`).
 * Throws a single `Error` naming every invalid variable and the reason,
 * never the value, when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: ConfigError[] = [];

  const nodeEnv = readField(
    errors,
    env,
    'NODE_ENV',
    z.enum(['development', 'test', 'production']),
    'development',
    'must be one of: development, test, production',
  );

  const agentDisplayName = readField(
    errors,
    env,
    'AGENT_DISPLAY_NAME',
    z.string().min(1),
    'Lance',
    'must be a non-empty string',
  );

  const mode = readField(
    errors,
    env,
    'LANCE_MODE',
    SystemModeSchema,
    'dry_run',
    'must be one of: live, dry_run',
  );

  const timeZone = readField(
    errors,
    env,
    'TIME_ZONE',
    TimeZoneSchema,
    'Europe/London',
    'must be a valid IANA time zone name',
  );

  // ADR 0008: production reaches Postgres via an Entra access token, handled
  // entirely in @lance/db, so DATABASE_URL is optional there.
  const databaseUrlRaw = raw(env, 'DATABASE_URL');
  let databaseUrl: string | undefined;
  if (databaseUrlRaw === undefined) {
    if (nodeEnv !== 'production') {
      errors.push({ variable: 'DATABASE_URL', reason: 'is required outside production' });
    }
    databaseUrl = undefined;
  } else {
    const result = z.string().url().safeParse(databaseUrlRaw);
    if (!result.success) {
      errors.push({ variable: 'DATABASE_URL', reason: 'must be a valid connection URL' });
      databaseUrl = undefined;
    } else {
      databaseUrl = result.data;
    }
  }

  const models: Config['models'] = {
    planner: readModel(errors, env, 'MODEL_PLANNER', 'EFFORT_PLANNER', 'claude-opus-5', 'high'),
    critic: readModel(errors, env, 'MODEL_CRITIC', 'EFFORT_CRITIC', 'claude-sonnet-5', 'medium'),
    criticDraft: readModel(
      errors,
      env,
      'MODEL_CRITIC_DRAFT',
      'EFFORT_CRITIC_DRAFT',
      'claude-opus-5',
      'high',
    ),
    triage: readModel(errors, env, 'MODEL_TRIAGE', 'EFFORT_TRIAGE', 'claude-sonnet-5', 'medium'),
    label: readModel(errors, env, 'MODEL_LABEL', 'EFFORT_LABEL', 'claude-haiku-4-5', 'low'),
  };

  const anthropicBaseUrlRaw = raw(env, 'ANTHROPIC_BASE_URL');
  let anthropicBaseUrl: string | undefined;
  if (anthropicBaseUrlRaw === undefined) {
    anthropicBaseUrl = undefined;
  } else {
    const result = z.string().url().safeParse(anthropicBaseUrlRaw);
    if (!result.success) {
      errors.push({ variable: 'ANTHROPIC_BASE_URL', reason: 'must be a valid absolute URL' });
      anthropicBaseUrl = undefined;
    } else {
      anthropicBaseUrl = result.data;
    }
  }

  // MODEL_PRICES_JSON entries are merged over the defaults, keyed by model
  // id, so an override can add or replace one model's prices without
  // repeating the rest of the table.
  const priceOverrides = readField<PriceTable>(
    errors,
    env,
    'MODEL_PRICES_JSON',
    PriceTableSchema,
    {},
    'must be JSON matching { [modelId]: { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok } }',
    toJson,
  );
  const prices: PriceTable = { ...DEFAULT_PRICES, ...priceOverrides };

  const cost: Config['cost'] = {
    dailyCeilingGbp: readField(
      errors,
      env,
      'COST_DAILY_CEILING_GBP',
      z.number().positive(),
      15,
      'must be a positive number',
      toNumber,
    ),
    usdToGbp: readField(
      errors,
      env,
      'COST_USD_TO_GBP',
      z.number().positive(),
      0.78,
      'must be a positive number',
      toNumber,
    ),
  };

  const scheduler: Config['scheduler'] = {
    tickSeconds: readField(
      errors,
      env,
      'SCHEDULER_TICK_SECONDS',
      z.number().int().positive(),
      30,
      'must be a positive integer',
      toNumber,
    ),
  };

  const modelLimiter: Config['modelLimiter'] = {
    concurrency: readField(
      errors,
      env,
      'MODEL_CONCURRENCY',
      z.number().int().positive(),
      4,
      'must be a positive integer',
      toNumber,
    ),
    principalBurst: readField(
      errors,
      env,
      'MODEL_PRINCIPAL_BURST',
      z.number().int().positive(),
      6,
      'must be a positive integer',
      toNumber,
    ),
    principalRunsPerMinute: readField(
      errors,
      env,
      'MODEL_PRINCIPAL_RUNS_PER_MINUTE',
      z.number().positive(),
      12,
      'must be a positive number',
      toNumber,
    ),
  };

  const proposals: Config['proposals'] = {
    expiryHours: readField(
      errors,
      env,
      'PROPOSALS_EXPIRY_HOURS',
      z.number().int().positive(),
      48,
      'must be a positive integer',
      toNumber,
    ),
  };

  const interruption: Config['interruption'] = {
    quietHoursStart: readField(
      errors,
      env,
      'INTERRUPTION_QUIET_HOURS_START',
      HhMmSchema,
      '19:00',
      'must be "HH:MM" in 24-hour time',
    ),
    quietHoursEnd: readField(
      errors,
      env,
      'INTERRUPTION_QUIET_HOURS_END',
      HhMmSchema,
      '07:00',
      'must be "HH:MM" in 24-hour time',
    ),
    pushBudgetPerHour: readField(
      errors,
      env,
      'INTERRUPTION_PUSH_BUDGET_PER_HOUR',
      z.number().int().positive(),
      3,
      'must be a positive integer',
      toNumber,
    ),
  };

  const promotion: Config['promotion'] = {
    threshold: readField(
      errors,
      env,
      'PROMOTION_THRESHOLD',
      z.number().int().positive(),
      10,
      'must be a positive integer',
      toNumber,
    ),
    minSpanDays: readField(
      errors,
      env,
      'PROMOTION_MIN_SPAN_DAYS',
      z.number().int().positive(),
      14,
      'must be a positive integer',
      toNumber,
    ),
  };

  const watchers: Config['watchers'] = {
    dryRunDaysForNewWatcher: readField(
      errors,
      env,
      'WATCHERS_DRY_RUN_DAYS_FOR_NEW_WATCHER',
      z.number().int().positive(),
      5,
      'must be a positive integer',
      toNumber,
    ),
  };

  const inboxAgent: Config['inboxAgent'] = {
    watermarkAlert:
      readField(
        errors,
        env,
        'INBOX_AGENT_WATERMARK_ALERT',
        z.enum(['true', 'false']),
        'false',
        'must be true or false',
        (value) => value,
      ) === 'true',
    watermarkMaxAgeHours: readField(
      errors,
      env,
      'INBOX_AGENT_WATERMARK_MAX_AGE_HOURS',
      z.number().positive(),
      24,
      'must be a positive number of hours',
      toNumber,
    ),
  };

  const triage: Config['triage'] = {
    bulkLabels: readField(
      errors,
      env,
      'TRIAGE_BULK_LABELS',
      z.array(MailLabelSchema).min(1),
      ['Newsletters', 'Notifications'],
      'must be a comma-separated list of mail labels, at least one',
      toCommaList,
    ),
  };

  // Twice the default MODEL_CONCURRENCY across the two queues: each job
  // holds at most one model slot at a time, so four of each keeps the
  // limiter's four slots busy while some jobs are between calls
  // (docs/runbooks/load-test.md).
  const modelQueues: Config['modelQueues'] = {
    concurrency: readField(
      errors,
      env,
      'MODEL_QUEUE_CONCURRENCY',
      z.number().int().positive(),
      4,
      'must be a positive integer',
      toNumber,
    ),
  };

  const briefs: Config['briefs'] = {
    minFreeBlockHours: readField(
      errors,
      env,
      'BRIEFS_MIN_FREE_BLOCK_HOURS',
      z.number().positive(),
      2,
      'must be a positive number',
      toNumber,
    ),
  };

  const retention: Config['retention'] = {
    mailBodiesDays: readField(
      errors,
      env,
      'RETENTION_MAIL_BODIES_DAYS',
      z.number().int().positive(),
      90,
      'must be a positive integer',
      toNumber,
    ),
    transcriptsDays: readField(
      errors,
      env,
      'RETENTION_TRANSCRIPTS_DAYS',
      z.number().int().positive(),
      180,
      'must be a positive integer',
      toNumber,
    ),
    ledgerDays: readField(
      errors,
      env,
      'RETENTION_LEDGER_DAYS',
      z.number().int().positive(),
      730,
      'must be a positive integer',
      toNumber,
    ),
    modelLogsDays: readField(
      errors,
      env,
      'RETENTION_MODEL_LOGS_DAYS',
      z.number().int().positive(),
      30,
      'must be a positive integer',
      toNumber,
    ),
  };

  const offboarding: Config['offboarding'] = {
    afterRoleLossDays: readField(
      errors,
      env,
      'OFFBOARD_AFTER_ROLE_LOSS_DAYS',
      z.number().int().positive(),
      7,
      'must be a positive integer',
      toNumber,
    ),
  };

  const featureFlags: Config['featureFlags'] = {
    graphWrites: readField(
      errors,
      env,
      'FF_GRAPH_WRITES',
      z.boolean(),
      false,
      'must be one of: true, false, 1, 0',
      toBoolean,
    ),
    notionWrites: readField(
      errors,
      env,
      'FF_NOTION_WRITES',
      z.boolean(),
      false,
      'must be one of: true, false, 1, 0',
      toBoolean,
    ),
    slackWrites: readField(
      errors,
      env,
      'FF_SLACK_WRITES',
      z.boolean(),
      false,
      'must be one of: true, false, 1, 0',
      toBoolean,
    ),
  };

  const slack: Config['slack'] = {
    channelId: readField(
      errors,
      env,
      'SLACK_CHANNEL_ID',
      z.string().min(1),
      'C0BU7P278N5',
      'must be a non-empty string',
    ),
  };

  const dom: Config['dom'] = {
    name: readField(
      errors,
      env,
      'DOM_NAME',
      z.string().min(1),
      'Dom Selvon',
      'must be a non-empty name',
    ),
    // Dom's UPN is the same address in every environment.
    email: readField(
      errors,
      env,
      'DOM_EMAIL',
      z.string().min(3),
      'dom@valliance.ai',
      'must be an email address',
    ),
  };

  const notion: Config['notion'] = {
    tasksDataSourceId: readField(
      errors,
      env,
      'NOTION_TASKS_DATA_SOURCE_ID',
      z.string().min(1),
      '20257534-6e48-81fe-b4b5-000b69ecace6',
      'must be a non-empty string',
    ),
    tasksDatabaseId: readField(
      errors,
      env,
      'NOTION_TASKS_DATABASE_ID',
      z.string().min(1),
      '20257534-6e48-8190-9ebb-cfb6997b3bb4',
      'must be a non-empty string',
    ),
    meetingsDataSourceId: readField<string | null>(
      errors,
      env,
      'NOTION_MEETINGS_DATA_SOURCE_ID',
      z.string().min(1).nullable(),
      null,
      'must be a non-empty string when set',
    ),
    domUserId: readField(
      errors,
      env,
      'NOTION_DOM_USER_ID',
      z.string().min(1),
      '1fdd872b-594c-8146-b22f-00028f1f5a41',
      'must be a non-empty string',
    ),
    permittedTaskProperties: readField(
      errors,
      env,
      'NOTION_PERMITTED_TASK_PROPERTIES',
      z.array(z.string().min(1)).min(1),
      [...DEFAULT_PERMITTED_TASK_PROPERTIES],
      'must be a comma-separated list of non-empty property names',
      toCommaList,
    ),
  };

  if (errors.length > 0) {
    const lines = errors.map((error) => `  - ${error.variable}: ${error.reason}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  return {
    nodeEnv,
    agentDisplayName,
    mode,
    timeZone,
    database: {
      url: databaseUrl,
      startupWaitSeconds: readField(
        errors,
        env,
        'LANCE_STARTUP_WAIT_SECONDS',
        z.number().int().nonnegative(),
        600,
        'must be a whole number of seconds, zero or more',
        toNumber,
      ),
    },
    models,
    anthropic: { baseUrl: anthropicBaseUrl },
    prices,
    cost,
    scheduler,
    modelLimiter,
    proposals,
    interruption,
    promotion,
    watchers,
    inboxAgent,
    triage,
    modelQueues,
    briefs,
    retention,
    offboarding,
    featureFlags,
    slack,
    dom,
    notion,
  };
}

let cachedConfig: Config | undefined;

/** Lazily loads and caches the config from `process.env` for the life of the process. */
export function getConfig(): Config {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}
