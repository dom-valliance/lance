/**
 * Runs the commitment extraction eval from the command line:
 *
 *   pnpm --filter @lance/agents eval:commitments
 *
 * Environment:
 *   EVAL_EXTRACTOR  `scripted` replays the fixtures' own expected commitments,
 *                   which proves the harness scores itself at F1 1.0. Anything
 *                   else uses the real extractor.
 *   EVAL_FILTER     substring of the fixture id to restrict the run.
 *   EVAL_MIN_F1     regression floor; the process exits 1 below it (spec 14).
 */
import { pathToFileURL } from 'node:url';

import type { CommitmentFixture } from './fixtures.js';
import {
  COMMITMENTS_FIXTURES_DIR,
  formatReport,
  runCommitmentEval,
  type CommitmentEvalOptions,
  type CommitmentExtractor,
  type ExtractedCommitment,
} from './run.js';

/** Where the real extractor lives, owned by the extraction work, not by this harness. */
const EXTRACTOR_MODULE = '../../commitments/extract.js';

/** Replays the expected commitments, so any score below 1.0 is a harness bug. */
export const scriptedExtractor: CommitmentExtractor = (record) =>
  Promise.resolve(record.expected.map((commitment) => ({ ...commitment, recordId: record.id })));

/** What the extractor reads: the fixture without the answers. */
function toSource(record: CommitmentFixture): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    dom: record.dom,
    participants: record.participants,
    occurredAt: null,
    text: record.text,
  };
}

/**
 * Imports `createCommitmentExtractor` at call time. The module is written
 * separately from this harness, so a missing export, a changed signature or a
 * factory that needs agent deps has to fail with an instruction rather than a
 * resolver stack trace or an undefined property.
 */
export async function loadModelExtractor(): Promise<CommitmentExtractor> {
  const specifier = EXTRACTOR_MODULE;
  let module: Record<string, unknown>;
  try {
    module = (await import(specifier)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `Cannot load ${EXTRACTOR_MODULE} from the commitment eval. Write packages/agents/src/commitments/extract.ts exporting createCommitmentExtractor, or run with EVAL_EXTRACTOR=scripted to exercise the harness alone.`,
      { cause },
    );
  }
  const factory = module.createCommitmentExtractor;
  if (typeof factory !== 'function') {
    throw new Error(
      `${EXTRACTOR_MODULE} does not export createCommitmentExtractor as a function. The eval calls createCommitmentExtractor() and expects an async (source, correlationId) => CommitmentCandidate[].`,
    );
  }
  if (factory.length > 0) {
    throw new Error(
      `createCommitmentExtractor takes ${String(factory.length)} argument(s), which this CLI cannot supply: the agent deps (model runner, run recorder, ledger, budget reader) belong to apps/worker. Call runCommitmentEval from the worker with a wired extractor, or run this CLI with EVAL_EXTRACTOR=scripted.`,
    );
  }
  const extract: unknown = (factory as () => unknown)();
  if (typeof extract !== 'function') {
    throw new Error(
      `createCommitmentExtractor() returned ${typeof extract}, not a function. The eval expects it to return an async (source, correlationId) => CommitmentCandidate[].`,
    );
  }
  const call = extract as (
    source: unknown,
    correlationId: string,
  ) => Promise<ExtractedCommitment[]>;
  return (record) => call(toSource(record), `commitments-eval:${record.id}`);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const extract =
    env.EVAL_EXTRACTOR === 'scripted' ? scriptedExtractor : await loadModelExtractor();
  const wanted = env.EVAL_FILTER;
  const filter: Pick<CommitmentEvalOptions, 'filter'> =
    wanted === undefined ? {} : { filter: (record) => record.id.includes(wanted) };
  const result = await runCommitmentEval({
    extract,
    fixturesDir: COMMITMENTS_FIXTURES_DIR,
    ...filter,
  });
  console.info(formatReport(result));

  const floor = env.EVAL_MIN_F1 === undefined ? null : Number(env.EVAL_MIN_F1);
  if (floor !== null && !Number.isNaN(floor) && result.totals.f1 < floor) {
    console.error(
      `F1 ${result.totals.f1.toFixed(3)} is below the EVAL_MIN_F1 floor of ${floor.toFixed(3)}.`,
    );
    return 1;
  }
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main();
}
