import {
  COMMITMENTS_FIXTURES_DIR,
  loadCommitmentFixtures,
  type CommitmentFixture,
} from './fixtures.js';
import { scoreCommitments, type CommitmentScore, type ScorableCommitment } from './score.js';

/**
 * What an extractor returns. `recordId` and `dueConfidence` are part of the
 * triage candidate shape but play no part in scoring, so they are optional
 * here and any extra fields are ignored.
 */
export type ExtractedCommitment = ScorableCommitment & {
  dueConfidence?: number;
  evidenceQuote?: string;
  recordId?: string;
};

/** Injected by the caller: the harness never builds an extractor itself. */
export type CommitmentExtractor = (record: CommitmentFixture) => Promise<ExtractedCommitment[]>;

export interface CommitmentEvalOptions {
  extract: CommitmentExtractor;
  fixturesDir: string;
  /** Runs only the fixtures this returns true for. */
  filter?: (record: CommitmentFixture) => boolean;
}

export interface CommitmentRecordResult {
  id: string;
  kind: CommitmentFixture['kind'];
  expectedCount: number;
  actualCount: number;
  score: CommitmentScore;
}

export interface CommitmentEvalTotals {
  records: number;
  expected: number;
  actual: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  dueMatches: number;
  duePairs: number;
  dueAccuracy: number | null;
}

export interface CommitmentEvalResult {
  fixturesDir: string;
  records: CommitmentRecordResult[];
  totals: CommitmentEvalTotals;
}

export { COMMITMENTS_FIXTURES_DIR };

/** Runs the extractor over every fixture and micro-averages the per-record scores. */
export async function runCommitmentEval({
  extract,
  fixturesDir,
  filter,
}: CommitmentEvalOptions): Promise<CommitmentEvalResult> {
  const fixtures = loadCommitmentFixtures(fixturesDir).filter(
    (record) => filter === undefined || filter(record),
  );

  const records: CommitmentRecordResult[] = [];
  for (const fixture of fixtures) {
    const actual = await extract(fixture);
    records.push({
      id: fixture.id,
      kind: fixture.kind,
      expectedCount: fixture.expected.length,
      actualCount: actual.length,
      score: scoreCommitments(fixture.expected, actual),
    });
  }

  const sum = (pick: (result: CommitmentRecordResult) => number): number =>
    records.reduce((total, result) => total + pick(result), 0);

  const truePositives = sum((result) => result.score.truePositives);
  const falsePositives = sum((result) => result.score.falsePositives);
  const falseNegatives = sum((result) => result.score.falseNegatives);
  const predicted = truePositives + falsePositives;
  const relevant = truePositives + falseNegatives;
  const precision = predicted === 0 ? (relevant === 0 ? 1 : 0) : truePositives / predicted;
  const recall = relevant === 0 ? (predicted === 0 ? 1 : 0) : truePositives / relevant;
  const duePairs = sum((result) => result.score.matches.length);
  const dueMatches = sum((result) => result.score.dueMatches);

  return {
    fixturesDir,
    records,
    totals: {
      records: records.length,
      expected: sum((result) => result.expectedCount),
      actual: sum((result) => result.actualCount),
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      dueMatches,
      duePairs,
      dueAccuracy: duePairs === 0 ? null : dueMatches / duePairs,
    },
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function pad(value: string, width: number, alignRight = false): string {
  return alignRight ? value.padStart(width) : value.padEnd(width);
}

/** A fixed width table of the per-record scores, then the headline figures. */
export function formatReport(result: CommitmentEvalResult): string {
  const headers = ['record', 'kind', 'exp', 'act', 'tp', 'fp', 'fn', 'f1', 'due'];
  const rows = result.records.map((record) => [
    record.id,
    record.kind,
    String(record.expectedCount),
    String(record.actualCount),
    String(record.score.truePositives),
    String(record.score.falsePositives),
    String(record.score.falseNegatives),
    record.score.f1.toFixed(2),
    record.score.dueAccuracy === null ? '-' : record.score.dueAccuracy.toFixed(2),
  ]);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => pad(cell, widths[column] ?? 0, column > 1)).join('  ');

  const { totals } = result;
  return [
    line(headers),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
    `Records ${totals.records}, expected ${totals.expected}, extracted ${totals.actual}.`,
    `True positives ${totals.truePositives}, false positives ${totals.falsePositives}, false negatives ${totals.falseNegatives}.`,
    `F1 ${totals.f1.toFixed(3)}, precision ${percent(totals.precision)}, recall ${percent(totals.recall)}.`,
    `Due date accuracy ${
      totals.dueAccuracy === null ? 'not applicable' : percent(totals.dueAccuracy)
    } over ${totals.duePairs} matched pairs.`,
  ].join('\n');
}
