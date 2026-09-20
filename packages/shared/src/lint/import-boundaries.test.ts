import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';

// Four levels up from packages/shared/src/lint/ is the repo root, where
// eslint.config.js lives. Fixtures are written under the real package
// directories the boundary rule keys off, so the config's path-based
// overrides apply to them exactly as they would to real source files.
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

const allFixtures = [agentsFixture, policyFixture, executorFixture, apiFixture];

function absolutePath(fixture: Fixture): string {
  return path.join(repoRoot, fixture.relPath);
}

async function writeFixtures(): Promise<void> {
  for (const fixture of allFixtures) {
    const abs = absolutePath(fixture);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, fixture.content, 'utf8');
  }
}

async function removeFixtures(): Promise<void> {
  await Promise.all(allFixtures.map((fixture) => rm(absolutePath(fixture), { force: true })));
}

function restrictedImportErrors(messages: Linter.LintMessage[]): Linter.LintMessage[] {
  return messages.filter((message) => message.ruleId === 'no-restricted-imports');
}

async function lintAllFixtures(): Promise<Map<string, Linter.LintMessage[]>> {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintFiles(allFixtures.map((fixture) => absolutePath(fixture)));
  const byPath = new Map<string, Linter.LintMessage[]>();
  for (const result of results) {
    byPath.set(result.filePath, restrictedImportErrors(result.messages));
  }
  return byPath;
}

describe('import boundary rules', () => {
  afterEach(async () => {
    await removeFixtures();
  });

  it('rejects @anthropic-ai/sdk import outside packages/agents', async () => {
    await writeFixtures();
    const byPath = await lintAllFixtures();
    const errors = byPath.get(absolutePath(policyFixture)) ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('packages/agents');
  }, 30000);

  it('allows @anthropic-ai/sdk import inside packages/agents', async () => {
    await writeFixtures();
    const byPath = await lintAllFixtures();
    const errors = byPath.get(absolutePath(agentsFixture)) ?? [];
    expect(errors).toHaveLength(0);
  }, 30000);

  it('rejects @lance/connectors/writes import outside apps/worker/src/executor', async () => {
    await writeFixtures();
    const byPath = await lintAllFixtures();
    const errors = byPath.get(absolutePath(apiFixture)) ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('executor');
  }, 30000);

  it('allows @lance/connectors/writes import inside apps/worker/src/executor', async () => {
    await writeFixtures();
    const byPath = await lintAllFixtures();
    const errors = byPath.get(absolutePath(executorFixture)) ?? [];
    expect(errors).toHaveLength(0);
  }, 30000);
});
