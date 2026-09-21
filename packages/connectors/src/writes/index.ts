/**
 * Connector write functions. This entry point is importable only from
 * apps/worker/src/executor (ESLint boundary, CLAUDE.md non-negotiable 2).
 * Each connector adds its writes here; reads stay on the package root.
 */
export const WRITES_ENTRY = 'writes';
