import type { GraphConnector, GraphReads, NotionConnector } from '@lance/connectors';
import { graphWrites, notionWrites } from '@lance/connectors/writes';
import type { Config } from '@lance/shared';
import type { ExecutionWriters } from './dispatch.js';

/**
 * Adapters from the connector writes to what the dispatcher calls. This file
 * sits inside the executor because it is the only place allowed to import
 * the writes entry point (CLAUDE.md non-negotiable 2).
 */
export function graphExecutionWriters(
  graph: GraphConnector,
  reads: GraphReads,
): NonNullable<ExecutionWriters['graph']> {
  return {
    applyCategories: (input) => graphWrites.applyCategories(graph, input),
    moveMessage: (input) => graphWrites.moveMessage(graph, input),
    createDraft: (input) => graphWrites.createDraft(graph, input),
    createReplyDraft: (input) => graphWrites.createReplyDraft(graph, input),
    createEvent: (input) => graphWrites.createEvent(graph, input),
    resolveFolderId: async (displayName) => {
      const folders = await reads.listMailFolders();
      return (
        folders.find((folder) => folder.displayName?.toLowerCase() === displayName.toLowerCase())
          ?.id ?? null
      );
    },
  };
}

export function notionExecutionWriters(
  notion: NotionConnector,
  config: Pick<Config, 'notion'>,
): NonNullable<ExecutionWriters['notion']> {
  return {
    createTask: (input) =>
      notionWrites.createTask(notion, {
        dataSourceId: config.notion.tasksDataSourceId,
        permittedProperties: config.notion.permittedTaskProperties,
        input,
      }),
  };
}
