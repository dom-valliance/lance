export const APP_NAME = '@lance/worker';

export { PauseGate } from './scheduler/gate.js';
export type { GateVerdict } from './scheduler/gate.js';
export { createBoss, startBoss, BOSS_SCHEMA } from './scheduler/boss.js';
export { QUEUES } from './scheduler/queues.js';
export type { ExecuteJob, QueueName } from './scheduler/queues.js';
export {
  executeProposal,
  registerExecutor,
  noConnectorWrites,
  EXECUTOR,
} from './executor/index.js';
export type { ConnectorWrite, ExecutorDeps, ExecuteOutcome } from './executor/index.js';
