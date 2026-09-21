import { describe, expect, it } from 'vitest';
import { getConfig, loadConfig } from './config.js';

const minimalTestEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://lance_app:pw@localhost:5432/lance_test',
};

describe('loadConfig defaults', () => {
  it('loads every documented default from a near-empty env in test mode', () => {
    const config = loadConfig(minimalTestEnv);

    expect(config.nodeEnv).toBe('test');
    expect(config.agentDisplayName).toBe('Lance');
    expect(config.mode).toBe('dry_run');
    expect(config.timeZone).toBe('Europe/London');
    expect(config.database.url).toBe(minimalTestEnv.DATABASE_URL);

    expect(config.models).toEqual({
      planner: { id: 'claude-opus-5', effort: 'high' },
      critic: { id: 'claude-sonnet-5', effort: 'medium' },
      criticDraft: { id: 'claude-opus-5', effort: 'high' },
      triage: { id: 'claude-sonnet-5', effort: 'medium' },
      label: { id: 'claude-haiku-4-5', effort: 'low' },
    });

    expect(config.anthropic.baseUrl).toBeUndefined();

    expect(config.prices).toEqual({
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
    });

    expect(config.cost).toEqual({ dailyCeilingGbp: 15, usdToGbp: 0.78 });
    expect(config.scheduler).toEqual({ tickSeconds: 30 });
    expect(config.proposals).toEqual({ expiryHours: 48 });
    expect(config.interruption).toEqual({
      quietHoursStart: '19:00',
      quietHoursEnd: '07:00',
      pushBudgetPerHour: 3,
    });
    expect(config.promotion).toEqual({ threshold: 10, minSpanDays: 14 });
    expect(config.watchers).toEqual({ dryRunDaysForNewWatcher: 5 });
    expect(config.briefs).toEqual({ minFreeBlockHours: 2 });
    expect(config.retention).toEqual({
      mailBodiesDays: 90,
      transcriptsDays: 180,
      ledgerDays: 730,
      modelLogsDays: 30,
    });
    expect(config.featureFlags).toEqual({
      graphWrites: false,
      notionWrites: false,
      slackWrites: false,
    });
    expect(config.slack).toEqual({ channelId: 'C0BU7P278N5' });
    expect(config.notion).toEqual({
      tasksDataSourceId: '20257534-6e48-81fe-b4b5-000b69ecace6',
      tasksDatabaseId: '20257534-6e48-8190-9ebb-cfb6997b3bb4',
      meetingsDataSourceId: '1fc57534-6e48-804e-a193-000bec4176ab',
      domUserId: '1fdd872b-594c-8146-b22f-00028f1f5a41',
      permittedTaskProperties: [
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
      ],
    });
  });

  it('defaults nodeEnv to development and requires DATABASE_URL there too', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://localhost:5432/lance' })).not.toThrow();
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost:5432/lance' });
    expect(config.nodeEnv).toBe('development');
  });

  it('does not require DATABASE_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).not.toThrow();
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.database.url).toBeUndefined();
  });
});

describe('loadConfig env overrides', () => {
  it('applies the documented override for every field', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      AGENT_DISPLAY_NAME: 'Ian',
      LANCE_MODE: 'live',
      TIME_ZONE: 'America/New_York',
      DATABASE_URL: 'postgres://user:pw@db:5432/lance',
      MODEL_PLANNER: 'claude-opus-6',
      EFFORT_PLANNER: 'max',
      MODEL_CRITIC: 'claude-sonnet-6',
      EFFORT_CRITIC: 'low',
      MODEL_CRITIC_DRAFT: 'claude-opus-6',
      EFFORT_CRITIC_DRAFT: 'xhigh',
      MODEL_TRIAGE: 'claude-sonnet-6',
      EFFORT_TRIAGE: 'high',
      MODEL_LABEL: 'claude-haiku-5',
      EFFORT_LABEL: 'medium',
      ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
      MODEL_PRICES_JSON: JSON.stringify({
        'claude-opus-6': {
          inputPerMTok: 6,
          outputPerMTok: 30,
          cacheReadPerMTok: 0.6,
          cacheWritePerMTok: 7.5,
        },
      }),
      COST_DAILY_CEILING_GBP: '25',
      COST_USD_TO_GBP: '0.8',
      SCHEDULER_TICK_SECONDS: '15',
      PROPOSALS_EXPIRY_HOURS: '24',
      INTERRUPTION_QUIET_HOURS_START: '20:00',
      INTERRUPTION_QUIET_HOURS_END: '08:00',
      INTERRUPTION_PUSH_BUDGET_PER_HOUR: '5',
      PROMOTION_THRESHOLD: '20',
      PROMOTION_MIN_SPAN_DAYS: '21',
      WATCHERS_DRY_RUN_DAYS_FOR_NEW_WATCHER: '3',
      BRIEFS_MIN_FREE_BLOCK_HOURS: '1.5',
      RETENTION_MAIL_BODIES_DAYS: '30',
      RETENTION_TRANSCRIPTS_DAYS: '60',
      RETENTION_LEDGER_DAYS: '365',
      RETENTION_MODEL_LOGS_DAYS: '7',
      FF_GRAPH_WRITES: 'true',
      FF_NOTION_WRITES: '1',
      FF_SLACK_WRITES: 'false',
      SLACK_CHANNEL_ID: 'C0OVERRIDE',
      NOTION_TASKS_DATA_SOURCE_ID: 'override-data-source',
      NOTION_TASKS_DATABASE_ID: 'override-database',
      NOTION_MEETINGS_DATA_SOURCE_ID: 'override-meetings-data-source',
      NOTION_DOM_USER_ID: 'override-user',
      NOTION_PERMITTED_TASK_PROPERTIES: 'Title, Status',
    };

    const config = loadConfig(env);

    expect(config.nodeEnv).toBe('production');
    expect(config.agentDisplayName).toBe('Ian');
    expect(config.mode).toBe('live');
    expect(config.timeZone).toBe('America/New_York');
    expect(config.database.url).toBe(env.DATABASE_URL);
    expect(config.models.planner).toEqual({ id: 'claude-opus-6', effort: 'max' });
    expect(config.models.critic).toEqual({ id: 'claude-sonnet-6', effort: 'low' });
    expect(config.models.criticDraft).toEqual({ id: 'claude-opus-6', effort: 'xhigh' });
    expect(config.models.triage).toEqual({ id: 'claude-sonnet-6', effort: 'high' });
    expect(config.models.label).toEqual({ id: 'claude-haiku-5', effort: 'medium' });
    expect(config.anthropic.baseUrl).toBe('https://anthropic.example.com');
    expect(config.prices['claude-opus-6']).toEqual({
      inputPerMTok: 6,
      outputPerMTok: 30,
      cacheReadPerMTok: 0.6,
      cacheWritePerMTok: 7.5,
    });
    // Overrides merge with, not replace, the defaults.
    expect(config.prices['claude-sonnet-5']).toBeDefined();
    expect(config.cost).toEqual({ dailyCeilingGbp: 25, usdToGbp: 0.8 });
    expect(config.scheduler).toEqual({ tickSeconds: 15 });
    expect(config.proposals).toEqual({ expiryHours: 24 });
    expect(config.interruption).toEqual({
      quietHoursStart: '20:00',
      quietHoursEnd: '08:00',
      pushBudgetPerHour: 5,
    });
    expect(config.promotion).toEqual({ threshold: 20, minSpanDays: 21 });
    expect(config.watchers).toEqual({ dryRunDaysForNewWatcher: 3 });
    expect(config.briefs).toEqual({ minFreeBlockHours: 1.5 });
    expect(config.retention).toEqual({
      mailBodiesDays: 30,
      transcriptsDays: 60,
      ledgerDays: 365,
      modelLogsDays: 7,
    });
    expect(config.featureFlags).toEqual({
      graphWrites: true,
      notionWrites: true,
      slackWrites: false,
    });
    expect(config.slack).toEqual({ channelId: 'C0OVERRIDE' });
    expect(config.notion).toEqual({
      tasksDataSourceId: 'override-data-source',
      tasksDatabaseId: 'override-database',
      meetingsDataSourceId: 'override-meetings-data-source',
      domUserId: 'override-user',
      permittedTaskProperties: ['Title', 'Status'],
    });
  });
});

describe('loadConfig validation failures', () => {
  it('throws one error naming every invalid variable and never the values supplied', () => {
    const secretLookingValue = 'sk-should-never-appear-in-the-error';
    let thrown: unknown;
    try {
      loadConfig({
        NODE_ENV: 'sideways',
        LANCE_MODE: 'turbo',
        SCHEDULER_TICK_SECONDS: 'not-a-number',
        FF_GRAPH_WRITES: secretLookingValue,
        DATABASE_URL: 'postgres://lance:pw@localhost:5432/lance',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('NODE_ENV');
    expect(message).toContain('LANCE_MODE');
    expect(message).toContain('SCHEDULER_TICK_SECONDS');
    expect(message).toContain('FF_GRAPH_WRITES');
    expect(message).not.toContain('sideways');
    expect(message).not.toContain('turbo');
    expect(message).not.toContain('not-a-number');
    expect(message).not.toContain(secretLookingValue);
    // Only one error is thrown for the whole batch of problems.
    expect(message.split('\n').filter((line) => line.trim().startsWith('-'))).toHaveLength(4);
  });

  it('rejects DATABASE_URL missing in development', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrowError(/DATABASE_URL/);
  });
});

describe('getConfig', () => {
  it('returns the same cached instance across calls', () => {
    // getConfig reads real process.env, so this test supplies a minimal
    // valid environment itself rather than depending on the ambient shell.
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://lance:pw@localhost:5432/lance_getconfig_test';
    try {
      expect(getConfig()).toBe(getConfig());
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});
