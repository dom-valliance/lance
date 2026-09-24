/**
 * The node and edge labels the ontology knows (spec 5.2) and the layer each
 * belongs to (ADR 0017). This table is the one place a label's layer is
 * decided: writes stamp it, the backfill applies it to existing graphs,
 * and reads filter on it.
 */

export const NODE_LABEL_VALUES = [
  'Person',
  'Organisation',
  'Meeting',
  'Task',
  'Commitment',
  'Thread',
  'Document',
  'Project',
  'Agent',
] as const;

export type NodeLabel = (typeof NODE_LABEL_VALUES)[number];

export const EDGE_LABEL_VALUES = [
  'WORKS_AT',
  'ATTENDED',
  'ORGANISED',
  'MENTIONS',
  'ASSIGNED_TO',
  'OWES',
  'OWED_TO',
  'ABOUT',
  'DERIVED_FROM',
  'PARTICIPATED_IN',
  'RELATES_TO',
  'SAME_AS',
] as const;

export type EdgeLabel = (typeof EDGE_LABEL_VALUES)[number];

export const NODE_LABELS: ReadonlySet<string> = new Set(NODE_LABEL_VALUES);
export const EDGE_LABELS: ReadonlySet<string> = new Set(EDGE_LABEL_VALUES);

/**
 * `reference`: key nodes for facts held in Foundry (populated in Phase 7).
 * `shared`: what the organisation has learned, visible to every principal.
 * `private`: one principal's evidence, visible to that principal only.
 */
export const LAYER_VALUES = ['reference', 'shared', 'private'] as const;
export type Layer = (typeof LAYER_VALUES)[number];

/**
 * ADR 0017. A Task's layer depends on its source: the Notion All Tasks
 * database is team-visible (ADR 0009), a Jamie or Lance task is the
 * principal's own. `nodes.Task` is the layer of a task from any source
 * not listed in `sharedTaskSources`.
 */
export const ONTOLOGY_LAYERS = {
  nodes: {
    Person: 'shared',
    Organisation: 'shared',
    Meeting: 'shared',
    Project: 'shared',
    Task: 'private',
    Thread: 'private',
    Commitment: 'private',
    Document: 'private',
    Agent: 'private',
  },
  sharedTaskSources: ['notion'],
  edges: {
    ATTENDED: 'private',
    MENTIONS: 'private',
    PARTICIPATED_IN: 'private',
    DERIVED_FROM: 'private',
    ABOUT: 'private',
    OWES: 'private',
    OWED_TO: 'private',
    ASSIGNED_TO: 'private',
    WORKS_AT: 'shared',
    ORGANISED: 'shared',
    RELATES_TO: 'shared',
    SAME_AS: 'shared',
  },
} as const satisfies {
  nodes: Record<NodeLabel, Layer>;
  sharedTaskSources: readonly string[];
  edges: Record<EdgeLabel, Layer>;
};

/** The layer a node of `label` is written to; `source` matters only for a Task. */
export function nodeLayer(label: NodeLabel, source?: string | null): Layer {
  if (
    label === 'Task' &&
    typeof source === 'string' &&
    (ONTOLOGY_LAYERS.sharedTaskSources as readonly string[]).includes(source)
  ) {
    return 'shared';
  }
  return ONTOLOGY_LAYERS.nodes[label];
}

export function edgeLayer(label: EdgeLabel): Layer {
  return ONTOLOGY_LAYERS.edges[label];
}
