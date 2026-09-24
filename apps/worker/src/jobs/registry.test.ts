import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { scheduleDeclared } from './reconcile.js';
import {
  SYSTEM_JOBS,
  boundsViolation,
  declarationFor,
  effectiveSchedules,
  shortestGapMinutes,
  type JobDeclaration,
} from './registry.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const RECONCILER = 'apps/worker/src/jobs/reconcile.ts';
const ZONE = 'Europe/London';

const job = (slug: string): JobDeclaration => {
  const declared = declarationFor(slug);
  if (declared === undefined) throw new Error(`${slug} is not declared`);
  return declared;
};

/** Every TypeScript source file under the apps' and packages' src directories. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === 'node_modules') continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
    }
  };
  for (const top of ['apps', 'packages']) {
    for (const name of readdirSync(join(REPO, top))) {
      const src = join(REPO, top, name, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // A workspace without a src directory has nothing to scan.
      }
    }
  }
  return out;
}

describe('the job registry', () => {
  it('declares each slug once', () => {
    const slugs = SYSTEM_JOBS.map((declared) => declared.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('locks alert delivery, proposal expiry, retention, the budget guard and the organisation jobs', () => {
    expect(
      SYSTEM_JOBS.filter((declared) => declared.locked)
        .map((declared) => declared.slug)
        .sort(),
    ).toEqual([
      'alerts-deliver',
      'detector-budget_guard',
      'expire-proposals',
      'jobs-reconcile',
      'onboarding-prefill',
      'organisation-budget-guard',
      'retention',
      'role-check',
    ]);
  });

  it('runs retention nightly for every principal whatever their status, and nothing else that way', () => {
    expect(job('retention')).toMatchObject({
      schedules: ['0 3 * * *'],
      scope: 'principal',
      locked: true,
      everyStatus: true,
    });
    expect(SYSTEM_JOBS.filter((declared) => declared.everyStatus).map((d) => d.slug)).toEqual([
      'retention',
    ]);
  });

  it('runs only the reconciler, the organisation budget, the role check and the onboarding prefill once for the organisation', () => {
    expect(
      SYSTEM_JOBS.filter((declared) => declared.scope === 'organisation').map(
        (declared) => declared.slug,
      ),
    ).toEqual(['jobs-reconcile', 'organisation-budget-guard', 'role-check', 'onboarding-prefill']);
  });

  it('runs morning briefs several at a time and every other queue one at a time', () => {
    expect(job('brief-morning').concurrency).toBeGreaterThan(1);
    expect(SYSTEM_JOBS.filter((declared) => declared.concurrency !== 1).map((d) => d.slug)).toEqual(
      ['brief-morning'],
    );
  });

  it('runs the role check nightly at 02:30', () => {
    expect(job('role-check').schedules).toEqual(['30 2 * * *']);
  });

  it('declares every watcher and detector at the cadence it ran on before the registry', () => {
    expect(job('watcher-graph-mail').schedules).toEqual([
      '*/10 7-18 * * 1-5',
      '0 0-6,19-23 * * 1-5',
      '0 * * * 0,6',
    ]);
    expect(job('brief-morning').schedules).toEqual(['30 6 * * 1-5']);
    expect(job('detector-budget_guard').schedules).toEqual(['*/15 * * * *']);
  });

  it('has default schedules that are all within their own bounds', () => {
    for (const declared of SYSTEM_JOBS) {
      for (const cron of declared.schedules) {
        if (declared.schedules.length > 1) continue;
        expect({ slug: declared.slug, violation: boundsViolation(declared, cron, ZONE) }).toEqual({
          slug: declared.slug,
          violation: null,
        });
      }
    }
  }, 60_000);
});

describe('schedule overrides', () => {
  it('accepts a morning brief moved within its window', () => {
    expect(effectiveSchedules(job('brief-morning'), '0 7 * * 1-5', ZONE)).toEqual({
      schedules: ['0 7 * * 1-5'],
      refusedOverride: null,
    });
  });

  it('refuses a morning brief moved outside its window and keeps the default', () => {
    const effective = effectiveSchedules(job('brief-morning'), '0 10 * * 1-5', ZONE);
    expect(effective.schedules).toEqual(['30 6 * * 1-5']);
    expect(effective.refusedOverride).toMatch(/outside 05:30 to 08:30/);
  });

  it('refuses a watcher polled more often than it is today', () => {
    expect(shortestGapMinutes(job('watcher-graph-mail').schedules, ZONE)).toBe(10);
    expect(boundsViolation(job('watcher-graph-mail'), '*/5 * * * *', ZONE)).toMatch(
      /no more often than every 10/,
    );
    expect(boundsViolation(job('watcher-graph-mail'), '*/30 * * * *', ZONE)).toBeNull();
  });

  it('refuses an override that is not a cron expression', () => {
    expect(effectiveSchedules(job('brief-afternoon'), 'at four', ZONE).refusedOverride).toMatch(
      /five-field/,
    );
  });
});

describe('scheduling only what the registry declares (ADR 0025)', () => {
  it('refuses to schedule a queue the registry does not declare', async () => {
    const calls: string[] = [];
    const boss = {
      schedule: (name: string) => {
        calls.push(name);
        return Promise.resolve();
      },
    } as unknown as PgBoss;
    await expect(
      scheduleDeclared(boss, {
        queue: 'undeclared-job',
        key: 'undeclared-job',
        cron: '* * * * *',
        timeZone: ZONE,
        data: {},
      }),
    ).rejects.toThrow(/does not declare it/);
    expect(calls).toEqual([]);
  });

  it('finds no call to boss.schedule outside the reconciler', () => {
    const offenders = sourceFiles()
      .map((path) => ({ path: relative(REPO, path), text: readFileSync(path, 'utf8') }))
      .filter(({ path, text }) => path !== RECONCILER && /\.schedule\s*\(/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('keeps the reconciler to the one guarded call', () => {
    const text = readFileSync(join(REPO, RECONCILER), 'utf8');
    expect(text.match(/\.schedule\s*\(/g)).toHaveLength(1);
    expect(text.indexOf('isDeclaredQueue(desired.queue)')).toBeLessThan(text.indexOf('.schedule('));
  });
});
