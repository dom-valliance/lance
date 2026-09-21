import type { Price } from '@lance/shared';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** From the config price table; an estimate for reporting, not billing (ADR 0002). */
export function estimateCostUsd(usage: TokenUsage, price: Price): number {
  const perToken = (perMTok: number) => perMTok / 1_000_000;
  return (
    usage.inputTokens * perToken(price.inputPerMTok) +
    usage.outputTokens * perToken(price.outputPerMTok) +
    usage.cacheReadTokens * perToken(price.cacheReadPerMTok) +
    usage.cacheWriteTokens * perToken(price.cacheWritePerMTok)
  );
}
