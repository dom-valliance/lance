import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

// Four levels up from packages/shared/src/lint/ is the repo root, where
// eslint.config.js lives. Fixtures are linted as text under virtual paths
// inside the real package directories the boundary rule keys off, so the
// config's path-based overrides apply exactly as they would to real source
// files. Nothing is written to disk: a fixture on disk would be picked up
// by another workspace's tsc or vitest running at the same time.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface Fixture {
  relPath: string;
  content: string;
}

const agentsFixture: Fixture = {
  relPath: 'packages/agents/src/__boundary_fixture__.ts',
  content: "import '@anthropic-ai/sdk';\n",
};

const policyFixture: Fixture = {
  relPath: 'packages/policy/src/__boundary_fixture__.ts',
  content: "import '@anthropic-ai/sdk';\n",
};

const executorFixture: Fixture = {
  relPath: 'apps/worker/src/executor/__boundary_fixture__.ts',
  content: "import '@lance/connectors/writes';\n",
};

const apiFixture: Fixture = {
  relPath: 'apps/api/src/__boundary_fixture__.ts',
  content: "import '@lance/connectors/writes';\n",
};

const cypherImports = [
  "import { runCypher } from '@lance/ontology';\n",
  "import { sqlRunnerOf } from '@lance/ontology/src/cypher';\n",
  "import { drizzleRunner } from '@lance/ontology/src/cypher.js';\n",
  "import { runCypher } from '../../../packages/ontology/src/cypher.js';\n",
];

const workerFixturePath = 'apps/worker/src/__boundary_fixture__.ts';
const ontologyFixturePath = 'packages/ontology/src/__boundary_fixture__.ts';

function restrictedImportErrors(messages: Linter.LintMessage[]): Linter.LintMessage[] {
  return messages.filter((message) => message.ruleId === 'no-restricted-imports');
}

async function lintFixture(fixture: Fixture): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(fixture.content, {
    filePath: path.join(repoRoot, fixture.relPath),
  });
  return restrictedImportErrors(results.flatMap((result) => result.messages));
}

describe('import boundary rules', () => {
  it('rejects @anthropic-ai/sdk import outside packages/agents', async () => {
    const errors = await lintFixture(policyFixture);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('packages/agents');
  }, 30000);

  it('allows @anthropic-ai/sdk import inside packages/agents', async () => {
    expect(await lintFixture(agentsFixture)).toHaveLength(0);
  }, 30000);

  it('rejects @lance/connectors/writes import outside apps/worker/src/executor', async () => {
    const errors = await lintFixture(apiFixture);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('executor');
  }, 30000);

  it('allows @lance/connectors/writes import inside apps/worker/src/executor', async () => {
    expect(await lintFixture(executorFixture)).toHaveLength(0);
  }, 30000);

  it('rejects every import of the raw Cypher runners outside packages/ontology', async () => {
    for (const content of cypherImports) {
      for (const relPath of [workerFixturePath, apiFixture.relPath, executorFixture.relPath]) {
        const errors = await lintFixture({ relPath, content });
        expect(errors, `${relPath}: ${content}`).toHaveLength(1);
        expect(errors[0]?.message).toContain('OntologyRepository');
      }
    }
  }, 60000);

  it('allows the Cypher runners inside packages/ontology', async () => {
    expect(
      await lintFixture({
        relPath: ontologyFixturePath,
        content: "import { runCypher } from './cypher.js';\n",
      }),
    ).toHaveLength(0);
  }, 30000);

  it('allows the repository and resolution helpers from @lance/ontology anywhere', async () => {
    expect(
      await lintFixture({
        relPath: workerFixturePath,
        content: "import { OntologyRepository, normaliseEmail } from '@lance/ontology';\n",
      }),
    ).toHaveLength(0);
  }, 30000);
});
