import { describe, expect, it } from 'vitest';
import { runDrill } from './drill.js';

describe('the offboarding drill', () => {
  it('refuses any database that is not on this machine', async () => {
    await expect(
      runDrill('postgres://u:p@psql-lance-dev.postgres.database.azure.com/lance'),
    ).rejects.toThrow(/local database only/);
  });
});
