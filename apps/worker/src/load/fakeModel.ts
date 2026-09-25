import { AsyncLocalStorage } from 'node:async_hooks';
import type { BetaMessage, BetaToolRunnerParams, ModelRun, ModelRunner } from '@lance/agents';
import { textMessage } from '@lance/agents/testing';
import { MAIL_LABELS } from '@lance/shared';
import type { Random } from './random.js';

/**
 * The load harness's stand-in for Anthropic (docs/runbooks/load-test.md).
 * Every call sleeps for a latency drawn from a seeded source, answers with
 * output the calling agent's schema accepts, and reports token counts of
 * the size a real call of that agent has, so the fair-share limiter, the
 * budgets and the cost ledger are exercised without a network call.
 *
 * An agent's tool loop is several model calls inside one limiter slot; the
 * runner plays that out as `turns` calls of their own latency each.
 */

export type LoadAgent = 'mail-label' | 'triage' | 'planner' | 'commitments' | 'critic' | 'debrief';

/** Which principal a model call runs for; the harness sets it where the limiter admits the run. */
export const modelCallScope = new AsyncLocalStorage<{ principalId: string }>();

export interface ModelCallRecord {
  agent: LoadAgent;
  principalId: string | null;
  startedAt: number;
  finishedAt: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

interface AgentProfile {
  /** Model calls in one run: a tool loop reads before it answers. */
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** Per call. Sized from the prompts: the system prompts cache, the record or brief does not. */
export const AGENT_PROFILES: Record<LoadAgent, AgentProfile> = {
  'mail-label': { turns: 1, inputTokens: 450, cacheReadTokens: 700, outputTokens: 40 },
  triage: { turns: 2, inputTokens: 2500, cacheReadTokens: 1800, outputTokens: 450 },
  planner: { turns: 3, inputTokens: 5000, cacheReadTokens: 2200, outputTokens: 900 },
  commitments: { turns: 1, inputTokens: 3000, cacheReadTokens: 800, outputTokens: 300 },
  critic: { turns: 1, inputTokens: 800, cacheReadTokens: 600, outputTokens: 120 },
  debrief: { turns: 1, inputTokens: 2000, cacheReadTokens: 700, outputTokens: 450 },
};

/** The line each agent's system prompt opens with, which is how a call is told apart. */
const SYSTEM_MARKERS: readonly [LoadAgent, string][] = [
  ['mail-label', 'You label one mail message'],
  ['triage', "'s triage agent."],
  ['planner', "'s planner."],
  ['commitments', 'You extract commitments'],
  ['critic', 'You are the critic for'],
  ['debrief', 'You draft follow-up email'],
];

function systemText(params: BetaToolRunnerParams): string {
  const system = params.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((block) => block.text).join('\n');
  return '';
}

function promptText(params: BetaToolRunnerParams): string {
  const first = params.messages[0];
  if (first === undefined) return '';
  return typeof first.content === 'string'
    ? first.content
    : first.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

export function agentOf(params: BetaToolRunnerParams): LoadAgent {
  const system = systemText(params);
  const match = SYSTEM_MARKERS.find(([, marker]) => system.includes(marker));
  if (match === undefined) {
    throw new Error(
      `The load harness's model runner does not know the agent whose system prompt starts "${system.slice(0, 80)}". Add it to SYSTEM_MARKERS in apps/worker/src/load/fakeModel.ts.`,
    );
  }
  return match[0];
}

const firstMatch = (text: string, pattern: RegExp): string | null =>
  pattern.exec(text)?.[1] ?? null;
const allMatches = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => match[1] ?? '').filter((value) => value !== '');

export interface OutputOptions {
  /** Share of triage runs that return one task candidate, which becomes a proposal card. */
  taskCandidateRate: number;
}

/** A JSON answer the agent's output schema accepts, grounded in ids its prompt carries. */
export function outputFor(
  agent: LoadAgent,
  prompt: string,
  random: Random,
  options: OutputOptions,
): object {
  switch (agent) {
    case 'mail-label':
      return { labels: [random.pick(MAIL_LABELS)], riskLanguage: false };
    case 'triage': {
      const recordId = firstMatch(prompt, /recordId: (\S+)/);
      const email = firstMatch(prompt, /([a-z0-9.]+@[a-z0-9.-]+\.[a-z]+)/i);
      const candidate =
        recordId !== null && recordId !== 'unknown' && random.next() < options.taskCandidateRate;
      return {
        importance: 0.4,
        urgency: 0.3,
        summary: 'A routine update that needs no reply today.',
        entities:
          email === null
            ? []
            : [
                {
                  kind: 'person',
                  name: email.split('@')[0] ?? email,
                  email,
                  domain: email.split('@')[1] ?? null,
                  confidence: 0.9,
                },
              ],
        commitments: [],
        taskCandidates: candidate
          ? [
              {
                title: 'Send the revised proposal to the client',
                description: null,
                dueDate: null,
                assigneeName: null,
                priority: 'Medium',
                evidenceQuote: 'Could you send the revised proposal across before Friday?',
                recordId,
              },
            ]
          : [],
        proposalsSubmitted: 0,
        alertCandidates: [],
        decisions: [],
        openQuestions: [],
      };
    }
    case 'planner': {
      const meetings = allMatches(prompt, /^Meeting (\S+):/gm);
      const tasks = allMatches(prompt, /^ {2}- (\S+) \|/gm).slice(0, 5);
      return {
        meetings: meetings.map((id) => ({
          id,
          objectives: ['Agree the next step on the open work.', 'Confirm who owns the follow-up.'],
        })),
        tasks: tasks.map((taskId, index) => ({
          taskId,
          rank: index + 1,
          reason: 'Due today and a client is waiting on it.',
        })),
        holdsProposed: 0,
      };
    }
    case 'commitments':
      return { commitments: [] };
    case 'critic':
      return { notes: [] };
    case 'debrief':
      return {
        subject: 'Actions from our meeting',
        bodyText: 'Thanks for the time today. The actions we agreed are below.',
      };
  }
}

export interface LatencyModelRunnerOptions {
  random: Random;
  /** Per model call, inclusive. Zero and zero answers at once. */
  latencyMs: { min: number; max: number };
  output: OutputOptions;
  now?: () => number;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** Plus or minus a fifth, so two calls of one agent are not identical. */
const jitter = (value: number, random: Random): number =>
  Math.round(value * (0.8 + random.next() * 0.4));

export class LatencyModelRunner implements ModelRunner {
  readonly calls: ModelCallRecord[] = [];
  private latency: { min: number; max: number };
  private readonly now: () => number;

  constructor(private readonly options: LatencyModelRunnerOptions) {
    this.latency = options.latencyMs;
    this.now = options.now ?? Date.now;
  }

  /** Changes the latency for later calls: the harness warms up at zero and measures at the default. */
  setLatency(latency: { min: number; max: number }): void {
    this.latency = latency;
  }

  run(params: BetaToolRunnerParams): ModelRun {
    const agent = agentOf(params);
    const profile = AGENT_PROFILES[agent];
    const { random } = this.options;
    const output = JSON.stringify(
      outputFor(agent, promptText(params), random, this.options.output),
    );
    const principalId = modelCallScope.getStore()?.principalId ?? null;
    const record: ModelCallRecord = {
      agent,
      principalId,
      startedAt: this.now(),
      finishedAt: 0,
      turns: profile.turns,
      inputTokens: 0,
      outputTokens: 0,
    };
    this.calls.push(record);
    const delays = Array.from({ length: profile.turns }, () =>
      random.between(this.latency.min, this.latency.max),
    );
    const messages: BetaMessage[] = delays.map((_, index) => {
      const usage = {
        input_tokens: jitter(profile.inputTokens, random),
        output_tokens: jitter(profile.outputTokens, random),
        cache_read_input_tokens: profile.cacheReadTokens,
      };
      record.inputTokens += usage.input_tokens + usage.cache_read_input_tokens;
      record.outputTokens += usage.output_tokens;
      const last = index === profile.turns - 1;
      const message = textMessage(last ? output : '{}', usage);
      return last ? message : { ...message, stop_reason: 'tool_use' };
    });
    let turn = 0;
    const finish = (): void => {
      record.finishedAt = this.now();
    };
    const iterator: AsyncIterator<BetaMessage> = {
      next: async () => {
        const message = messages[turn];
        if (message === undefined) return { done: true, value: undefined };
        await sleep(delays[turn] ?? 0);
        turn += 1;
        if (turn === messages.length) finish();
        return { done: false, value: message };
      },
    };
    const final = messages[messages.length - 1];
    return {
      [Symbol.asyncIterator]: () => iterator,
      done: () =>
        final === undefined ? Promise.reject(new Error('no model turns')) : Promise.resolve(final),
    };
  }
}
