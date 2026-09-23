import { describe, expect, it } from 'vitest';
import {
  EDGE_LABEL_VALUES,
  NODE_LABEL_VALUES,
  ONTOLOGY_LAYERS,
  edgeLayer,
  nodeLayer,
  type Layer,
} from './layers.js';

describe('ontology layers', () => {
  it('puts people, organisations, meetings and projects in the shared layer', () => {
    for (const label of ['Person', 'Organisation', 'Meeting', 'Project'] as const) {
      expect(nodeLayer(label)).toBe('shared');
    }
  });

  it('shares Notion tasks and keeps Jamie and Lance tasks private', () => {
    expect(nodeLayer('Task', 'notion')).toBe('shared');
    expect(nodeLayer('Task', 'jamie')).toBe('private');
    expect(nodeLayer('Task', 'lance')).toBe('private');
    expect(nodeLayer('Task')).toBe('private');
  });

  it('keeps threads, commitments, documents and agents private', () => {
    for (const label of ['Thread', 'Commitment', 'Document', 'Agent'] as const) {
      expect(nodeLayer(label)).toBe('private');
    }
  });

  it('keeps every observation edge private and shares the rest', () => {
    const expected: Record<string, Layer> = {
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
    };
    for (const label of EDGE_LABEL_VALUES) expect(edgeLayer(label)).toBe(expected[label]);
  });

  it('assigns a layer to every label and writes nothing to the reference layer yet', () => {
    expect(Object.keys(ONTOLOGY_LAYERS.nodes).sort()).toEqual([...NODE_LABEL_VALUES].sort());
    expect(Object.keys(ONTOLOGY_LAYERS.edges).sort()).toEqual([...EDGE_LABEL_VALUES].sort());
    const layers = [
      ...Object.values(ONTOLOGY_LAYERS.nodes),
      ...Object.values(ONTOLOGY_LAYERS.edges),
    ] as Layer[];
    expect(layers).not.toContain('reference');
  });
});
