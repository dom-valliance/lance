import type { BetaMessage, BetaToolRunnerParams, ModelRun, ModelRunner } from './client.js';
import type { RunFinish, RunRecorder, RunStart } from './runs.js';

/** Builds a final assistant message with the given text and usage. */
export function textMessage(text: string, usage: Partial<BetaMessage['usage']> = {}): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    context_management: null,
    container: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      inference_geo: null,
      iterations: null,
      ...usage,
    },
  } as unknown as BetaMessage;
}

/**
 * A model runner that replays scripted messages per call, recording the
 * params it was given so tests can assert prompt shape, caching and effort.
 */
export class ScriptedRunner implements ModelRunner {
  readonly calls: BetaToolRunnerParams[] = [];
  private readonly scripts: BetaMessage[][];

  constructor(scripts: BetaMessage[][]) {
    this.scripts = [...scripts];
  }

  run(params: BetaToolRunnerParams): ModelRun {
    this.calls.push(params);
    const script = this.scripts.shift() ?? [];
    const messages = [...script];
    const run: ModelRun = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            const value = messages.shift();
            return Promise.resolve(
              value === undefined ? { done: true, value: undefined } : { done: false, value },
            );
          },
        };
      },
      done: () => {
        const last = script[script.length - 1];
        return last === undefined
          ? Promise.reject(new Error('no scripted message'))
          : Promise.resolve(last);
      },
    };
    return run;
  }
}

export class MemoryRunRecorder implements RunRecorder {
  readonly starts: RunStart[] = [];
  readonly finishes: Array<{ runId: string } & RunFinish> = [];

  start(run: RunStart): Promise<string> {
    this.starts.push(run);
    return Promise.resolve(`run-${this.starts.length}`);
  }

  finish(runId: string, outcome: RunFinish): Promise<void> {
    this.finishes.push({ runId, ...outcome });
    return Promise.resolve();
  }
}
