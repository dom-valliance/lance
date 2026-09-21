import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';
import { readSecret, type Config } from '@lance/shared';

export type { BetaMessage, BetaToolRunnerParams };

/** What runAgent needs from the SDK: an iterable tool loop. Tests inject a scripted one. */
export interface ModelRun extends AsyncIterable<BetaMessage> {
  done(): Promise<BetaMessage>;
}

export interface ModelRunner {
  run(params: BetaToolRunnerParams): ModelRun;
}

/**
 * The only place the Anthropic client is constructed. ANTHROPIC_BASE_URL is
 * honoured through config so the Foundry endpoint can replace the direct
 * API without a code change (spec 16 Q4, ADR 0001).
 */
export function createAnthropicClient(config: Pick<Config, 'anthropic'>): Anthropic {
  return new Anthropic({
    apiKey: readSecret('ANTHROPIC_API_KEY'),
    ...(config.anthropic.baseUrl === undefined ? {} : { baseURL: config.anthropic.baseUrl }),
    maxRetries: 2,
  });
}

export function sdkModelRunner(client: Anthropic): ModelRunner {
  return {
    run: (params) => client.beta.messages.toolRunner({ ...params, stream: false }),
  };
}
