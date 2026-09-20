import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/db',
  'packages/ledger',
  'packages/policy',
  'packages/ontology',
  'packages/connectors',
  'packages/agents',
  'apps/web',
  'apps/api',
  'apps/worker',
]);
