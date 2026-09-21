import type { LedgerEventInputCandidate } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetExceededError } from './budget.js';
import {
  AgentOutputError,
  AgentStoppedError,
  runAgent,
  type AgentDefinition,
} from './defineAgent.js';
import { MemoryRunRecorder, ScriptedRunner, textMessage } from './testing.js';

const OutputSchema = z.object({ importance: z.number().min(0).max(1), summary: z.string() });

const definition: AgentDefinition<z.infer<typeof OutputSchema>> = {
  name: 'triage',
  version: '0.1.0',
  model: { id: 'claude-sonnet-5', effort: 'medium' },
  system: 'You are the triage agent.',
  tools: [],
  outputSchema: OutputSchema,
};

const config = {
  prices: {
    'claude-sonnet-5': {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    },
  },
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.78 },
};

function deps(runner: ScriptedRunner, spendUsd = 0) {
  const recorder = new MemoryRunRecorder();
  const events: LedgerEventInputCandidate[] = [];
  return {
    deps: {
      runner,
      recorder,
      ledger: {
        append: (input: LedgerEventInputCandidate) => (
          events.push(input),
          Promise.resolve({ id: 'evt' })
        ),
      },
      config,
      readSpendUsd: () => Promise.resolve(spendUsd),
      now: () => '2026-09-21T10:00:00.000Z',
    },
    recorder,
    events,
  };
}

const input = { correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', prompt: 'Triage this.' };

describe('runAgent', () => {
  it('sends a cached system prompt, adaptive thinking, the effort and the output format', async () => {
    const runner = new ScriptedRunner([[textMessage('{"importance":0.4,"summary":"fine"}')]]);
    const { deps: d } = deps(runner);
    const result = await runAgent(d, definition, input);
    expect(result.output).toEqual({ importance: 0.4, summary: 'fine' });
    const params = runner.calls[0];
    expect(params?.model).toBe('claude-sonnet-5');
    expect(params?.system).toEqual([
      { type: 'text', text: 'You are the triage agent.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(params?.thinking).toEqual({ type: 'adaptive' });
    expect(params?.output_config?.effort).toBe('medium');
    expect(params?.output_config?.format).toBeDefined();
    expect(params?.tool_choice).toBeUndefined();
  });

  it('records the run, sums usage across iterations and prices it from the table', async () => {
    const runner = new ScriptedRunner([
      [
        textMessage('thinking', {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: 500,
        }),
        textMessage('{"importance":1,"summary":"done"}', { input_tokens: 200, output_tokens: 50 }),
      ],
    ]);
    const { deps: d, recorder, events } = deps(runner);
    const result = await runAgent(d, definition, input);
    expect(result.iterations).toBe(2);
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 150,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
    });
    expect(result.estimatedCostUsd).toBeCloseTo(1200 * 2e-6 + 150 * 10e-6 + 500 * 0.2e-6, 9);
    expect(recorder.starts[0]).toMatchObject({
      agent: 'triage',
      model: 'claude-sonnet-5',
      correlationId: input.correlationId,
    });
    expect(recorder.finishes[0]).toMatchObject({ runId: 'run-1', status: 'succeeded' });
    expect(events.map((event) => event.kind)).toEqual(['cost_recorded']);
  });

  it('retries once with the validation error in context when the output fails the schema', async () => {
    const runner = new ScriptedRunner([
      [textMessage('{"importance":"high"}')],
      [textMessage('{"importance":0.9,"summary":"ok"}')],
    ]);
    const { deps: d, events } = deps(runner);
    const result = await runAgent(d, definition, input);
    expect(result.retried).toBe(true);
    expect(result.output.importance).toBe(0.9);
    const retryMessages = runner.calls[1]?.messages ?? [];
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[1]?.role).toBe('assistant');
    expect(JSON.stringify(retryMessages[2]?.content)).toContain(
      'did not match the required output schema',
    );
    expect(events.map((event) => event.kind)).toEqual(['failed', 'cost_recorded']);
  });

  it('fails after the second schema failure and records the run as failed', async () => {
    const runner = new ScriptedRunner([[textMessage('nonsense')], [textMessage('still nonsense')]]);
    const { deps: d, recorder } = deps(runner);
    await expect(runAgent(d, definition, input)).rejects.toBeInstanceOf(AgentOutputError);
    expect(recorder.finishes[0]).toMatchObject({ status: 'failed' });
  });

  it('refuses to run when the daily budget is exhausted', async () => {
    const runner = new ScriptedRunner([[textMessage('{}')]]);
    const { deps: d } = deps(runner, 20);
    await expect(runAgent(d, definition, input)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(runner.calls).toHaveLength(0);
  });

  it('treats a refusal as a failed run', async () => {
    const refused = { ...textMessage('{}'), stop_reason: 'refusal' as const };
    const runner = new ScriptedRunner([[refused]]);
    const { deps: d } = deps(runner);
    await expect(runAgent(d, definition, input)).rejects.toBeInstanceOf(AgentStoppedError);
  });

  it('refuses a model with no price configured', async () => {
    const runner = new ScriptedRunner([[textMessage('{}')]]);
    const { deps: d } = deps(runner);
    await expect(
      runAgent(d, { ...definition, model: { id: 'claude-unknown', effort: 'low' } }, input),
    ).rejects.toThrow(/No price configured/);
  });
});
