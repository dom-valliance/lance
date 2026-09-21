/**
 * Connector write functions. This entry point is importable only from
 * apps/worker/src/executor (ESLint boundary, CLAUDE.md non-negotiable 2).
 * Each connector adds its writes here; reads stay on the package root.
 */
export const WRITES_ENTRY = 'writes';

export { notionWrites } from '../notion/writes.js';
export type NotionWrites = typeof import('../notion/writes.js').notionWrites;
export { slackWrites } from '../slack/writes.js';
export type { SlackWrites } from '../slack/writes.js';
