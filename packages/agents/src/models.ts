/**
 * Which request features a model accepts. Adaptive thinking and the effort
 * parameter arrived with the Claude 4.6 generation; Haiku 4.5 rejects both
 * with a 400, which is a failed run and, on a watcher's label call, a
 * failed run per message per poll.
 */
const WITHOUT_ADAPTIVE_THINKING = ['claude-haiku-4-5'];

export function supportsAdaptiveThinking(modelId: string): boolean {
  return !WITHOUT_ADAPTIVE_THINKING.some((prefix) => modelId.startsWith(prefix));
}
