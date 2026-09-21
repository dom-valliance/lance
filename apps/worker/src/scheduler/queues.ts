/** Queue names. Watchers get one queue each, named by the runner in Phase 1. */
export const QUEUES = {
  execute: 'execute',
  triage: 'triage',
  chase: 'chase',
  tick: 'tick',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface ExecuteJob {
  proposalId: string;
}

/** The job the api's `/lance chase` and the Commitments page put on the queue. */
export interface ChaseJob {
  commitmentId: string;
}
