import type { Db } from '@lance/db';
import { isEdge, isVertex, runCypher, sqlRunnerOf } from './cypher.js';

/**
 * The whole graph, unscoped, in a stable order: for tests inside this
 * package that compare a graph before and after a rebuild, or check what
 * layer and principal every node and edge carries. Not exported from the
 * package entry, and the runners it uses stay internal (ADR 0017).
 */

export interface SnapshotNode {
  label: string;
  id: string;
  layer: unknown;
  principalId: unknown;
  properties: Record<string, unknown>;
}

export interface SnapshotEdge {
  label: string;
  from: string;
  to: string;
  layer: unknown;
  principalId: unknown;
  properties: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
}

export async function graphSnapshot(db: Db): Promise<GraphSnapshot> {
  const runner = sqlRunnerOf(db);
  const nodeRows = await runCypher(runner, 'MATCH (n) RETURN n');
  const edgeRows = await runCypher(runner, 'MATCH (a)-[r]->(b) RETURN a.id, b.id, r', {}, [
    'a',
    'b',
    'r',
  ]);
  const nodes = nodeRows.flatMap(([vertex]) =>
    isVertex(vertex)
      ? [
          {
            label: vertex.label,
            id: String(vertex.properties['id']),
            layer: vertex.properties['layer'] ?? null,
            principalId: vertex.properties['principal_id'] ?? null,
            properties: vertex.properties,
          },
        ]
      : [],
  );
  const edges = edgeRows.flatMap(([from, to, edge]) =>
    isEdge(edge)
      ? [
          {
            label: edge.label,
            from: String(from),
            to: String(to),
            layer: edge.properties['layer'] ?? null,
            principalId: edge.properties['principal_id'] ?? null,
            properties: edge.properties,
          },
        ]
      : [],
  );
  const nodeKey = (node: SnapshotNode): string => `${node.label}:${node.id}`;
  const edgeKey = (edge: SnapshotEdge): string =>
    `${edge.label}:${edge.from}:${edge.to}:${String(edge.principalId)}`;
  nodes.sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)));
  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return { nodes, edges };
}
