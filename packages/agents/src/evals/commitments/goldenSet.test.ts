import { describe, expect, it } from 'vitest';

import { scriptedExtractor } from './cli.js';
import { COMMITMENTS_FIXTURES_DIR, loadCommitmentFixtures } from './fixtures.js';
import { runCommitmentEval } from './run.js';

const fixtures = loadCommitmentFixtures(COMMITMENTS_FIXTURES_DIR);

describe('the commitment golden set', () => {
  it('holds twenty transcripts and thirty sent mails', () => {
    expect(fixtures.filter((record) => record.kind === 'transcript')).toHaveLength(20);
    expect(fixtures.filter((record) => record.kind === 'sent_mail')).toHaveLength(30);
  });

  it('gives every fixture a unique id', () => {
    expect(new Set(fixtures.map((record) => record.id)).size).toBe(fixtures.length);
  });

  it('includes at least five records that expect no commitments', () => {
    expect(fixtures.filter((record) => record.expected.length === 0).length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it('covers both directions', () => {
    const directions = new Set(
      fixtures.flatMap((record) => record.expected).map((item) => item.direction),
    );
    expect([...directions].sort()).toEqual(['inbound', 'outbound']);
  });

  it('covers commitments with and without a due date', () => {
    const due = fixtures.flatMap((record) => record.expected).map((item) => item.dueAt);
    expect(due.some((value) => value === null)).toBe(true);
    expect(due.some((value) => value !== null)).toBe(true);
  });

  it('quotes evidence verbatim from the record text', () => {
    for (const record of fixtures) {
      for (const item of record.expected) {
        expect(
          record.text.includes(item.evidenceQuote),
          `${record.id} quotes text that is not in the record: ${item.evidenceQuote}`,
        ).toBe(true);
      }
    }
  });

  it('names a counterparty that took part in the record', () => {
    for (const record of fixtures) {
      const addresses = record.participants
        .map((participant) => participant.email?.toLowerCase())
        .filter((email): email is string => email !== undefined);
      for (const item of record.expected) {
        if (item.counterpartyEmail !== null) {
          expect(addresses, `${record.id} names an unknown counterparty`).toContain(
            item.counterpartyEmail.toLowerCase(),
          );
        }
      }
    }
  });

  it('keeps Dom out of the counterparty field', () => {
    for (const record of fixtures) {
      for (const item of record.expected) {
        expect(item.counterpartyEmail?.toLowerCase()).not.toBe(record.dom.email);
      }
    }
  });

  it('scores the scripted extractor at F1 1.0 with perfect due dates', async () => {
    const result = await runCommitmentEval({
      extract: scriptedExtractor,
      fixturesDir: COMMITMENTS_FIXTURES_DIR,
    });
    expect(result.totals.f1).toBe(1);
    expect(result.totals.precision).toBe(1);
    expect(result.totals.recall).toBe(1);
    expect(result.totals.dueAccuracy).toBe(1);
    expect(result.totals.falsePositives).toBe(0);
    expect(result.totals.falseNegatives).toBe(0);
  });
});
