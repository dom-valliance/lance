import { readSecret } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { createNotionConnector } from './client.js';
import { getDataSourceSchema, queryTasksEditedSince } from './reads.js';
import { TASK_PROPERTY_NAMES } from './types.js';

/**
 * Reads only. These tests touch the real All Tasks DB, so they never create,
 * update or comment on anything. They run only when asked for explicitly.
 */
const live = process.env.LIVE_CONNECTOR_TESTS === '1' && Boolean(process.env.NOTION_TOKEN);

const DATA_SOURCE_ID =
  process.env.NOTION_TASKS_DATA_SOURCE_ID ?? '20257534-6e48-81fe-b4b5-000b69ecace6';

const SINCE_DAYS = 7;

describe.runIf(live)('notion connector against the live workspace', () => {
  const notion = () => createNotionConnector({ token: readSecret('NOTION_TOKEN') });

  it('still exposes every property ADR 0009 permits Lance to write', async () => {
    const schema = await getDataSourceSchema(notion(), DATA_SOURCE_ID);
    const names = schema.properties.map((property) => property.name);
    for (const permitted of Object.values(TASK_PROPERTY_NAMES)) {
      expect(names).toContain(permitted);
    }
  }, 30_000);

  it('returns tasks edited in the last week, oldest edit first', async () => {
    const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = await queryTasksEditedSince(notion(), {
      dataSourceId: DATA_SOURCE_ID,
      since,
    });
    const edits = result.tasks.map((task) => Date.parse(task.lastEditedTime));
    expect(edits).toEqual([...edits].sort((a, b) => a - b));
    for (const edit of edits) {
      expect(edit).toBeGreaterThan(Date.parse(since) - 60_000);
    }
  }, 60_000);
});
