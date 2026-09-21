import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { LedgerKindSchema, SourceSystemSchema } from '@lance/shared';
import { z } from 'zod';

export interface LedgerSearchRow {
  id: string;
  ts: string;
  kind: string;
  actor: string;
  sourceSystem: string | null;
  sourceRecordId: string | null;
  correlationId: string;
  summary: string | null;
}

export interface EntityMatch {
  id: string;
  label: string;
  display: string;
  confidence: number;
}

export interface ReadToolDeps {
  searchLedger(query: {
    correlationId?: string | undefined;
    kind?: string | undefined;
    limit: number;
  }): Promise<LedgerSearchRow[]>;
  getSourceRecord(system: string, recordId: string): Promise<Record<string, unknown> | null>;
  lookupEntity(query: string): Promise<EntityMatch[]>;
}

/** Read tools over the ledger, source records and the ontology (spec 7). Nothing here writes. */
export function readTools(deps: ReadToolDeps) {
  const ledgerSearch = betaZodTool({
    name: 'ledger_search',
    description:
      'Search the ledger for events, optionally by correlation id or kind. Returns the newest first.',
    inputSchema: z.object({
      correlationId: z.string().optional(),
      kind: LedgerKindSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    run: async (query) => JSON.stringify(await deps.searchLedger(query)),
  });

  const sourceGetRecord = betaZodTool({
    name: 'source_get_record',
    description: 'Fetch one record from a source system by id, as most recently observed.',
    inputSchema: z.object({ system: SourceSystemSchema, recordId: z.string().min(1) }),
    run: async ({ system, recordId }) => {
      const record = await deps.getSourceRecord(system, recordId);
      return record === null ? 'No such record has been observed.' : JSON.stringify(record);
    },
  });

  const ontologyLookup = betaZodTool({
    name: 'ontology_lookup',
    description:
      'Resolve a person, organisation or project by name, email or domain. Returns candidates with confidence.',
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    run: async ({ query }) => JSON.stringify(await deps.lookupEntity(query)),
  });

  return [ledgerSearch, sourceGetRecord, ontologyLookup];
}
