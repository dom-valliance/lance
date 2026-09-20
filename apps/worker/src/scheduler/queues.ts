/** Queue names. Watchers get one queue each, named by the runner in Phase 1. */
export const QUEUES = {
  execute: 'execute',
  triage: 'triage',
  tick: 'tick',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface ExecuteJob {
  proposalId: string;
}
