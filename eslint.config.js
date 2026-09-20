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

// Full restriction: no file may import the model SDK or connector write functions.
// Lifted selectively below for the two directories the boundary allows.
const fullBoundaryRestriction = [
  'error',
  {
    paths: [{ name: '@anthropic-ai/sdk', message: SDK_BOUNDARY_MESSAGE }],
    patterns: [
      { group: ['@anthropic-ai/sdk/*'], message: SDK_BOUNDARY_MESSAGE },
      {
        group: ['@lance/connectors/writes', '@lance/connectors/writes/*'],
        message: WRITES_BOUNDARY_MESSAGE,
      },
    ],
  },
];

// packages/agents may import the model SDK, but still not connector writes.
const agentsBoundaryRestriction = [
  'error',
  {
    patterns: [
      {
        group: ['@lance/connectors/writes', '@lance/connectors/writes/*'],
        message: WRITES_BOUNDARY_MESSAGE,
      },
    ],
  },
];

// apps/worker/src/executor may import connector writes, but still not the model SDK.
const executorBoundaryRestriction = [
  'error',
  {
    paths: [{ name: '@anthropic-ai/sdk', message: SDK_BOUNDARY_MESSAGE }],
    patterns: [{ group: ['@anthropic-ai/sdk/*'], message: SDK_BOUNDARY_MESSAGE }],
  },
];

const sourceGlobs = ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
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
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.ts'],
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
    files: ['packages/agents/src/**/*.ts'],
    rules: {
      'no-restricted-imports': agentsBoundaryRestriction,
    },
  },
  {
    files: ['apps/worker/src/executor/**/*.ts'],
    rules: {
      'no-restricted-imports': executorBoundaryRestriction,
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
