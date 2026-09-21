import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, readTools } from './index.js';

describe('@lance/agents', () => {
  it('exposes exactly three read tools and no write beyond create_proposal', () => {
    const tools = readTools({
      searchLedger: () => Promise.resolve([]),
      getSourceRecord: () => Promise.resolve(null),
      lookupEntity: () => Promise.resolve([]),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'ledger_search',
      'source_get_record',
      'ontology_lookup',
    ]);
    expect(PACKAGE_NAME).toBe('@lance/agents');
  });
});
