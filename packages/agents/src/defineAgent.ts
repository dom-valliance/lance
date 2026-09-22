import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaContentBlock,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  nowIso,
  type Config,
  type LedgerEventInputCandidate,
  type ModelConfig,
} from '@lance/shared';
import { ATTR_AGENT, ATTR_CORRELATION_ID, currentTraceIds, withSpan } from '@lance/telemetry';
import type { z } from 'zod';
import { BudgetExceededError, checkDailyBudget, type SpendReader } from './budget.js';
import { supportsAdaptiveThinking } from './models.js';
import type { BetaMessage, BetaToolRunnerParams, ModelRunner } from './client.js';
import { addUsage, estimateCostUsd, ZERO_USAGE, type TokenUsage } from './cost.js';
import type { RunRecorder } from './runs.js';

export interface AgentDefinition<TOutput> {
  name: string;
  version: string;
  model: ModelConfig;
  /** Stable text, cached with cache_control (spec 13). Put anything volatile in the prompt, not here. */
  system: string;
  /** The SDK's own tool list type; each entry comes from betaZodTool. */
  tools: BetaToolRunnerParams['tools'];
  outputSchema: z.ZodType<TOutput>;
  maxTokens?: number;
  maxIterations?: number;
}

export interface AgentRunInput {
  correlationId: string;
  prompt: string;
}

export interface AgentRunResult<TOutput> {
  output: TOutput;
  runId: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  iterations: number;
  /** True when the first reply failed the schema and the single retry produced the output. */
  retried: boolean;
}

export interface LedgerLike {
  append(input: LedgerEventInputCandidate): Promise<{ id: string }>;
}

export interface AgentDeps {
  runner: ModelRunner;
  recorder: RunRecorder;
  ledger: LedgerLike;
  config: Pick<Config, 'prices' | 'cost'>;
  readSpendUsd: SpendReader;
  /** Today's ceiling in GBP as Settings last set it; the config value is the fallback. */
  readCeilingGbp?: () => Promise<number>;
  now?: () => string;
}

export class AgentOutputError extends Error {
  override readonly name = 'AgentOutputError';
}

export class AgentStoppedError extends Error {
  override readonly name = 'AgentStoppedError';
}

function usageOf(message: BetaMessage): TokenUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

function lastText(content: BetaContentBlock[]): string | null {
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block?.type === 'text') return block.text;
  }
  return null;
}

function parseOutput<T>(
  schema: z.ZodType<T>,
  text: string | null,
): { ok: true; value: T } | { ok: false; issue: string } {
  if (text === null) return { ok: false, issue: 'The reply contained no text block.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issue: 'The reply was not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, issue: issues };
}

/**
 * Runs one model-backed agent (spec 7): fixed toolset, structured output
 * validated with Zod, one retry with the validation error in context, an
 * agent_runs row and a span per invocation, cost from the price table, and
 * the daily budget checked first. There is no write tool here other than
 * whatever `create_proposal` the caller registered.
 */
export async function runAgent<TOutput>(
  deps: AgentDeps,
  definition: AgentDefinition<TOutput>,
  input: AgentRunInput,
): Promise<AgentRunResult<TOutput>> {
  const now = deps.now ?? nowIso;
  const budget = await checkDailyBudget(deps.readSpendUsd, {
    ceilingGbp: await (deps.readCeilingGbp?.() ??
      Promise.resolve(deps.config.cost.dailyCeilingGbp)),
    usdToGbp: deps.config.cost.usdToGbp,
  });
  if (budget.state === 'exceeded') throw new BudgetExceededError(budget);

  const price = deps.config.prices[definition.model.id];
  if (price === undefined) {
    throw new Error(
      `No price configured for model ${definition.model.id}; add it to MODEL_PRICES_JSON so cost can be recorded (spec 13).`,
    );
  }

  return withSpan(
    `agent.${definition.name}`,
    {
      [ATTR_AGENT]: `${definition.name}@${definition.version}`,
      [ATTR_CORRELATION_ID]: input.correlationId,
    },
    async () => {
      const runId = await deps.recorder.start({
        agent: definition.name,
        version: definition.version,
        model: definition.model.id,
        correlationId: input.correlationId,
        traceId: currentTraceIds().traceId ?? null,
        startedAt: now(),
      });

      let usage = ZERO_USAGE;
      let iterations = 0;
      const messages: BetaMessageParam[] = [{ role: 'user', content: input.prompt }];

      const runOnce = async (): Promise<BetaMessage> => {
        const run = deps.runner.run({
          model: definition.model.id,
          max_tokens: definition.maxTokens ?? 16_000,
          system: [{ type: 'text', text: definition.system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools: definition.tools,
          ...(supportsAdaptiveThinking(definition.model.id)
            ? {
                thinking: { type: 'adaptive' },
                output_config: {
                  effort: definition.model.effort,
                  format: betaZodOutputFormat(definition.outputSchema),
                },
              }
            : { output_config: { format: betaZodOutputFormat(definition.outputSchema) } }),
          max_iterations: definition.maxIterations ?? 8,
        });
        let last: BetaMessage | null = null;
        for await (const message of run) {
          usage = addUsage(usage, usageOf(message));
          iterations += 1;
          last = message;
        }
        const final = last ?? (await run.done());
        if (final.stop_reason === 'refusal' || final.stop_reason === 'max_tokens') {
          throw new AgentStoppedError(
            `${definition.name} stopped with ${final.stop_reason}; no output was produced.`,
          );
        }
        return final;
      };

      const finish = async (status: 'succeeded' | 'failed', error?: string): Promise<number> => {
        const estimatedCostUsd = estimateCostUsd(usage, price);
        await deps.recorder.finish(runId, {
          finishedAt: now(),
          status,
          usage,
          estimatedCostUsd,
          ...(error === undefined ? {} : { error }),
        });
        await deps.ledger.append({
          ts: now(),
          actor: `agent:${definition.name}@${definition.version}`,
          kind: 'cost_recorded',
          sourceSystem: 'lance',
          correlationId: input.correlationId,
          payload: {
            runId,
            model: definition.model.id,
            status,
            ...usage,
            estimatedCostUsd,
            iterations,
          },
        });
        return estimatedCostUsd;
      };

      try {
        let final = await runOnce();
        let parsed = parseOutput(definition.outputSchema, lastText(final.content));
        let retried = false;
        if (!parsed.ok) {
          await deps.ledger.append({
            ts: now(),
            actor: `agent:${definition.name}@${definition.version}`,
            kind: 'failed',
            sourceSystem: 'lance',
            correlationId: input.correlationId,
            payload: { runId, reason: 'schema_validation', issue: parsed.issue, willRetry: true },
          });
          messages.push({ role: 'assistant', content: final.content });
          messages.push({
            role: 'user',
            content: `Your reply did not match the required output schema: ${parsed.issue}. Reply again with only the JSON object.`,
          });
          final = await runOnce();
          parsed = parseOutput(definition.outputSchema, lastText(final.content));
          retried = true;
          if (!parsed.ok) {
            throw new AgentOutputError(
              `${definition.name} produced output that failed the schema twice: ${parsed.issue}`,
            );
          }
        }
        const estimatedCostUsd = await finish('succeeded');
        return { output: parsed.value, runId, usage, estimatedCostUsd, iterations, retried };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finish('failed', message);
        throw error;
      }
    },
  );
}
