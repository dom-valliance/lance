import type { Db } from '@lance/db';
import type { OntologyRepository } from '@lance/ontology';
import type { SystemControl } from '@lance/ledger';
import type { Config } from '@lance/shared';
import type { RaiseAlertInput } from '../raise.js';

/**
 * A detector (spec 11) is deterministic code that looks at what Lance
 * already knows (observations, commitments, proposals, agent runs, the
 * ontology) and says which alerts should exist right now. It never posts:
 * the engine records what it returns through `raiseAlert`, which dedupes
 * on the key, and delivery decides when and whether Slack sees it.
 */
export interface DetectorContext {
  db: Db;
  config: Pick<Config, 'timeZone' | 'cost' | 'dom' | 'proposals' | 'briefs'>;
  ontology: OntologyRepository;
  /** Settings as Dom last saved them (spec 13 ceiling); the config default applies when absent. */
  control?: Pick<SystemControl, 'read'>;
  /** ISO instant the run is evaluated at; injected in tests. */
  now: () => string;
}

/** What a detector returns: the alert as `raiseAlert` takes it, minus the actor the engine adds. */
export type DetectedAlert = Omit<RaiseAlertInput, 'actor'>;

export interface Detector {
  /** Matches the alert kind it raises, for the Agents page and the ledger actor. */
  name: string;
  /** Cron expression in the configured time zone. */
  schedule: string;
  run(context: DetectorContext): Promise<DetectedAlert[]>;
}
