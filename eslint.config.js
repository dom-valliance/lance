// Flat ESLint config (ESM).
//
// Uses eslint-plugin-import-x rather than eslint-plugin-import: import-x is the
// actively maintained fork, ships native flat-config exports, and resolves
// TypeScript path/exports fields (via eslint-import-resolver-typescript) without
// the CommonJS compatibility shim eslint-plugin-import still needs under ESLint 9+.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import globals from 'globals';

const SDK_BOUNDARY_MESSAGE =
  'Model SDK imports are allowed only inside packages/agents (CLAUDE.md conventions)';
const WRITES_BOUNDARY_MESSAGE =
  'Connector write functions are callable only from apps/worker/src/executor (CLAUDE.md non-negotiable 2)';

const CYPHER_BOUNDARY_MESSAGE =
  'Raw Cypher runners (runCypher, sqlRunnerOf, drizzleRunner) are internal to packages/ontology; read and write the graph through OntologyRepository, which enforces the principal scope (ADR 0017)';

const sdkPath = { name: '@anthropic-ai/sdk', message: SDK_BOUNDARY_MESSAGE };
const sdkPattern = { group: ['@anthropic-ai/sdk/*'], message: SDK_BOUNDARY_MESSAGE };
const writesPattern = {
  group: [
    '@lance/connectors/writes',
    '@lance/connectors/writes/*',
    '**/connectors/src/writes',
    '**/connectors/src/writes/**',
  ],
  message: WRITES_BOUNDARY_MESSAGE,
};
// The package entry no longer exports the runners; the named-import entry
// catches a re-export creeping back, the pattern catches deep and relative
// imports of the module itself.
const cypherPath = {
  name: '@lance/ontology',
  importNames: ['runCypher', 'sqlRunnerOf', 'drizzleRunner'],
  message: CYPHER_BOUNDARY_MESSAGE,
};
const cypherPattern = {
  group: [
    '@lance/ontology/src/cypher',
    '@lance/ontology/src/cypher.*',
    '**/ontology/src/cypher',
    '**/ontology/src/cypher.*',
  ],
  message: CYPHER_BOUNDARY_MESSAGE,
};

// Full restriction: no file may import the model SDK, connector write functions
// or the raw Cypher runners. Lifted selectively below for the directories the
// boundary allows.
const fullBoundaryRestriction = [
  'error',
  {
    paths: [sdkPath, cypherPath],
    patterns: [sdkPattern, writesPattern, cypherPattern],
  },
];

// packages/agents may import the model SDK, but still not connector writes.
const agentsBoundaryRestriction = [
  'error',
  {
    paths: [cypherPath],
    patterns: [writesPattern, cypherPattern],
  },
];

// apps/worker/src/executor may import connector writes, but still not the model SDK.
const executorBoundaryRestriction = [
  'error',
  {
    paths: [sdkPath, cypherPath],
    patterns: [sdkPattern, cypherPattern],
  },
];

// packages/ontology owns the Cypher runners; everything else still applies.
const ontologyBoundaryRestriction = [
  'error',
  {
    paths: [sdkPath],
    patterns: [sdkPattern, writesPattern],
  },
];

// Virtual files the import boundary test lints as text (see
// packages/shared/src/lint/import-boundaries.test.ts). Nothing writes them.
const BOUNDARY_FIXTURE_PATHS = [
  'packages/agents/src/__boundary_fixture__.ts',
  'packages/policy/src/__boundary_fixture__.ts',
  'apps/worker/src/executor/__boundary_fixture__.ts',
  'apps/api/src/__boundary_fixture__.ts',
  'apps/worker/src/__boundary_fixture__.ts',
  'packages/ontology/src/__boundary_fixture__.ts',
];

const sourceGlobs = ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'fixtures/evals/**',
    ],
  },
  js.configs.recommended,
  {
    files: sourceGlobs,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // The boundary test in packages/shared/src/lint lints these paths
          // as in-memory text; they never exist on disk.
          allowDefaultProject: BOUNDARY_FIXTURE_PATHS,
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    // Config files outside src (next.config.ts, playwright.config.ts) are not
    // type-checked but still run under Node, so they get its globals here.
    languageOptions: {
      globals: { ...globals.node },
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          project: ['tsconfig.base.json', 'packages/*/tsconfig.json', 'apps/*/tsconfig.json'],
        }),
      ],
    },
    rules: {
      'import-x/no-duplicates': 'error',
      'no-restricted-imports': fullBoundaryRestriction,
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'debug', 'trace'] }],
    },
  },
  {
    files: ['packages/agents/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': agentsBoundaryRestriction,
    },
  },
  {
    files: ['apps/worker/src/executor/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': executorBoundaryRestriction,
    },
  },
  {
    files: ['packages/ontology/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ontologyBoundaryRestriction,
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
