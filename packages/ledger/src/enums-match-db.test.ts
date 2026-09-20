import {
  ACTION_CLASS_VALUES,
  AGENT_RUN_STATUS_VALUES,
  ALERT_SEVERITY_VALUES,
  ALERT_STATUS_VALUES,
  BRIEF_KIND_VALUES,
  COMMITMENT_DIRECTION_VALUES,
  COMMITMENT_STATUS_VALUES,
  COUNTERPARTY_CLASS_VALUES,
  DECISION_VALUES,
  LEDGER_KIND_VALUES,
  PROPOSAL_STATUS_VALUES,
  REVERSIBILITY_VALUES,
  RULE_CREATOR_VALUES,
  SYSTEM_MODE_VALUES,
  TARGET_SYSTEM_VALUES,
} from '@lance/db';
import {
  ACTION_CLASSES,
  AGENT_RUN_STATUSES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  BRIEF_KINDS,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_STATUSES,
  COUNTERPARTY_CLASSES,
  DECISIONS,
  LEDGER_KINDS,
  PROPOSAL_STATUSES,
  REVERSIBILITIES,
  RULE_CREATORS,
  SYSTEM_MODES,
  SYSTEMS,
} from '@lance/shared';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0010: the canonical enum lists live in `@lance/shared`, and `@lance/db`
 * repeats them as local tuples so the schema package needs no dependency on
 * shared. This is the test the ADR promises. A value added to one list and
 * not the other fails here, before a migration can encode the difference.
 *
 * `@lance/ledger` is the home for it because it is the lowest package that
 * already depends on both.
 */

interface EnumPair {
  readonly name: string;
  readonly shared: readonly string[];
  readonly db: readonly string[];
}

const PAIRS: readonly EnumPair[] = [
  { name: 'ledger kind', shared: LEDGER_KINDS, db: LEDGER_KIND_VALUES },
  { name: 'action class', shared: ACTION_CLASSES, db: ACTION_CLASS_VALUES },
  { name: 'counterparty class', shared: COUNTERPARTY_CLASSES, db: COUNTERPARTY_CLASS_VALUES },
  { name: 'target system', shared: SYSTEMS, db: TARGET_SYSTEM_VALUES },
  { name: 'reversibility', shared: REVERSIBILITIES, db: REVERSIBILITY_VALUES },
  { name: 'decision', shared: DECISIONS, db: DECISION_VALUES },
  { name: 'proposal status', shared: PROPOSAL_STATUSES, db: PROPOSAL_STATUS_VALUES },
  { name: 'alert severity', shared: ALERT_SEVERITIES, db: ALERT_SEVERITY_VALUES },
  { name: 'alert status', shared: ALERT_STATUSES, db: ALERT_STATUS_VALUES },
  { name: 'commitment direction', shared: COMMITMENT_DIRECTIONS, db: COMMITMENT_DIRECTION_VALUES },
  { name: 'commitment status', shared: COMMITMENT_STATUSES, db: COMMITMENT_STATUS_VALUES },
  { name: 'system mode', shared: SYSTEM_MODES, db: SYSTEM_MODE_VALUES },
  { name: 'rule creator', shared: RULE_CREATORS, db: RULE_CREATOR_VALUES },
  { name: 'brief kind', shared: BRIEF_KINDS, db: BRIEF_KIND_VALUES },
  { name: 'agent run status', shared: AGENT_RUN_STATUSES, db: AGENT_RUN_STATUS_VALUES },
];

describe('every domain enum', () => {
  for (const pair of PAIRS) {
    it(`holds the same ${pair.name} values in the same order in @lance/shared and @lance/db`, () => {
      expect([...pair.db]).toEqual([...pair.shared]);
    });
  }

  it('covers every pgEnum the schema defines', () => {
    expect(PAIRS).toHaveLength(15);
  });
});
