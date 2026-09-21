import type { Db } from '@lance/db';

/**
 * Cypher over Apache AGE (ADR 0004). Every statement runs through
 * `ag_catalog.cypher('lance_ontology', $$ ... $$, $1)`: the query text is a
 * literal Lance wrote, the parameters travel as one agtype map in the
 * single bound argument, and the columns come back as agtype text that is
 * parsed here. Nothing user-supplied is ever spliced into the query text.
 */

export const GRAPH_NAME = 'lance_ontology';

export type CypherParams = Record<string, unknown>;

/** A pool or a transaction client: anything with `query`. */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * AGE resolves the operators Cypher compiles to (`@>` on agtype above all)
 * through the search path, and fully qualified function names do not cover
 * them. Each statement therefore runs on a checked-out client whose search
 * path names ag_catalog first for the length of that statement.
 */
export function sqlRunnerOf(db: Db): SqlRunner {
  return {
    query: async (text, values) => {
      const client = await db.$client.connect();
      try {
        await client.query('SET search_path = ag_catalog, "$user", public');
        return await client.query(text, values as never[]);
      } finally {
        await client.query('RESET search_path').catch(() => undefined);
        client.release();
      }
    },
  };
}

/** AGE tags composite values with their type; JSON is what is left after the tags go. */
export function parseAgtype(text: string | null): unknown {
  if (text === null) return null;
  const stripped = text.replace(/::(vertex|edge|path|numeric)\b/g, '');
  return JSON.parse(stripped) as unknown;
}

export interface Vertex {
  id: number;
  label: string;
  properties: Record<string, unknown>;
}

export interface Edge {
  id: number;
  label: string;
  start_id: number;
  end_id: number;
  properties: Record<string, unknown>;
}

export function isVertex(value: unknown): value is Vertex {
  return (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    'properties' in value &&
    !('start_id' in value)
  );
}

/**
 * Runs one Cypher statement and returns the rows, each an array of parsed
 * columns in the order `columns` names them. The query text may not contain
 * `$$`, which would end the dollar quoting early.
 */
export async function runCypher(
  runner: SqlRunner,
  query: string,
  params: CypherParams = {},
  columns: readonly string[] = ['result'],
): Promise<unknown[][]> {
  if (query.includes('$$')) {
    throw new Error('A Cypher statement may not contain "$$"; it is the SQL dollar quote.');
  }
  const asList = columns.map((name) => `${quoteIdent(name)} ag_catalog.agtype`).join(', ');
  const sql = `SELECT * FROM ag_catalog.cypher('${GRAPH_NAME}', $$ ${query} $$, $1) AS (${asList})`;
  const { rows } = await runner.query(sql, [JSON.stringify(params)]);
  return rows.map((row) => columns.map((name) => parseAgtype(row[name] as string | null)));
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Cypher column names are lower-case identifiers; got "${name}".`);
  }
  return `"${name}"`;
}
