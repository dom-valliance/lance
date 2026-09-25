/**
 * Summary statistics for the load report: nearest-rank percentiles over
 * millisecond samples.
 */

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** The nearest-rank percentile of `values`, which need not be sorted; 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function summarise(values: readonly number[]): Summary {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
