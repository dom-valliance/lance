import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CommitmentFixtureSchema,
  loadCommitmentFixtures,
  type CommitmentFixture,
} from './fixtures.js';
import {
  COMMITMENTS_FIXTURES_DIR,
  formatReport,
  runCommitmentEval,
  type ExtractedCommitment,
} from './run.js';

const fixture = (over: Partial<CommitmentFixture> = {}): CommitmentFixture =>
  CommitmentFixtureSchema.parse({
    id: 'x01-sample',
    kind: 'sent_mail',
    dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
    participants: [{ name: 'Priya Nandra', email: 'priya.nandra@harlowbrook.example.test' }],
    text: 'I will send the statement of work by Friday.',
    expected: [
      {
        direction: 'outbound',
        description: 'Send Priya Nandra the statement of work',
        counterpartyName: 'Priya Nandra',
        counterpartyEmail: 'priya.nandra@harlowbrook.example.test',
        dueAt: '2026-09-25',
        dueConfidence: 0.9,
        evidenceQuote: 'I will send the statement of work by Friday.',
      },
    ],
    notes: 'Sample.',
    ...over,
  });

function writeFixtures(records: CommitmentFixture[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lance-commitment-eval-'));
  for (const record of records) {
    writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record), 'utf8');
  }
  return dir;
}

const echoExtractor = (record: CommitmentFixture): Promise<ExtractedCommitment[]> =>
  Promise.resolve(record.expected.map((item) => ({ ...item, recordId: record.id })));

describe('loadCommitmentFixtures', () => {
  it('reads the fixtures in id order', () => {
    const dir = writeFixtures([fixture({ id: 'x02-second' }), fixture({ id: 'x01-first' })]);
    expect(loadCommitmentFixtures(dir).map((record) => record.id)).toEqual([
      'x01-first',
      'x02-second',
    ]);
  });

  it('refuses a directory with no fixtures in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lance-commitment-eval-'));
    expect(() => loadCommitmentFixtures(dir)).toThrow(/No commitment fixtures found/);
  });

  it('names the file and the field when a fixture does not validate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lance-commitment-eval-'));
    writeFileSync(join(dir, 'x03-broken.json'), JSON.stringify({ id: 'x03-broken' }), 'utf8');
    expect(() => loadCommitmentFixtures(dir)).toThrow(/x03-broken\.json.*kind/s);
  });

  it('refuses a fixture whose id does not match its file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lance-commitment-eval-'));
    writeFileSync(join(dir, 'x04-renamed.json'), JSON.stringify(fixture()), 'utf8');
    expect(() => loadCommitmentFixtures(dir)).toThrow(/rename the file or the id/);
  });
});

describe('runCommitmentEval', () => {
  it('scores a perfect extractor at F1 1.0 across every record', async () => {
    const dir = writeFixtures([
      fixture({ id: 'x01-first' }),
      fixture({ id: 'x02-empty', expected: [] }),
    ]);
    const result = await runCommitmentEval({ extract: echoExtractor, fixturesDir: dir });
    expect(result.totals).toMatchObject({
      records: 2,
      expected: 1,
      actual: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      dueAccuracy: 1,
    });
  });

  it('micro-averages over records rather than averaging their F1 scores', async () => {
    const dense = fixture({
      id: 'x05-dense',
      expected: [
        ...fixture().expected,
        {
          direction: 'inbound',
          description: 'Priya Nandra to confirm the go live date',
          counterpartyName: 'Priya Nandra',
          counterpartyEmail: 'priya.nandra@harlowbrook.example.test',
          dueAt: null,
          dueConfidence: 0,
          evidenceQuote: 'I will send the statement of work by Friday.',
        },
      ],
    });
    const dir = writeFixtures([fixture({ id: 'x01-first' }), dense]);
    const result = await runCommitmentEval({
      extract: (record) =>
        record.id === 'x05-dense' ? Promise.resolve([]) : echoExtractor(record),
      fixturesDir: dir,
    });
    expect(result.totals).toMatchObject({ truePositives: 1, falseNegatives: 2, precision: 1 });
    expect(result.totals.recall).toBeCloseTo(1 / 3, 6);
    expect(result.totals.f1).toBeCloseTo(0.5, 6);
  });

  it('reports perfect scores when nothing is expected and nothing is extracted', async () => {
    const dir = writeFixtures([fixture({ id: 'x06-empty', expected: [] })]);
    const result = await runCommitmentEval({ extract: echoExtractor, fixturesDir: dir });
    expect(result.totals).toMatchObject({ precision: 1, recall: 1, f1: 1, dueAccuracy: null });
  });

  it('reports zero when an extractor invents commitments on empty records', async () => {
    const dir = writeFixtures([fixture({ id: 'x07-empty', expected: [] })]);
    const result = await runCommitmentEval({
      extract: () => Promise.resolve(fixture().expected),
      fixturesDir: dir,
    });
    expect(result.totals).toMatchObject({ falsePositives: 1, precision: 0, recall: 0, f1: 0 });
  });

  it('runs only the records the filter accepts', async () => {
    const dir = writeFixtures([fixture({ id: 'x01-first' }), fixture({ id: 'x02-second' })]);
    const result = await runCommitmentEval({
      extract: echoExtractor,
      fixturesDir: dir,
      filter: (record) => record.id.includes('second'),
    });
    expect(result.records.map((record) => record.id)).toEqual(['x02-second']);
  });
});

describe('formatReport', () => {
  it('prints a row per record and the headline figures', async () => {
    const dir = writeFixtures([
      fixture({ id: 'x01-first' }),
      fixture({ id: 'x02-empty', expected: [] }),
    ]);
    const report = formatReport(
      await runCommitmentEval({ extract: echoExtractor, fixturesDir: dir }),
    );
    expect(report).toContain('record');
    expect(report).toContain('x01-first');
    expect(report).toContain('x02-empty');
    expect(report).toContain('F1 1.000, precision 100.0%, recall 100.0%.');
    expect(report).toContain('Due date accuracy 100.0% over 1 matched pairs.');
  });

  it('says due accuracy does not apply when nothing matched', async () => {
    const dir = writeFixtures([fixture({ id: 'x08-empty', expected: [] })]);
    const report = formatReport(
      await runCommitmentEval({ extract: echoExtractor, fixturesDir: dir }),
    );
    expect(report).toContain('Due date accuracy not applicable');
  });
});

describe('COMMITMENTS_FIXTURES_DIR', () => {
  it('points at the committed synthetic set', () => {
    expect(COMMITMENTS_FIXTURES_DIR).toMatch(/fixtures\/evals\/commitments$/);
  });
});
