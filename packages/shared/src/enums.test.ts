import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  ActionClassSchema,
  AGENT_RUN_STATUSES,
  AgentRunStatusSchema,
  ALERT_KINDS,
  AlertKindSchema,
  ALERT_SEVERITIES,
  AlertSeveritySchema,
  ALERT_STATUSES,
  AlertStatusSchema,
  BRIEF_KINDS,
  BriefKindSchema,
  COMMITMENT_DIRECTIONS,
  CommitmentDirectionSchema,
  COMMITMENT_STATUSES,
  CommitmentStatusSchema,
  COUNTERPARTY_CLASSES,
  CounterpartyClassSchema,
  DECISIONS,
  DecisionSchema,
  HARD_FLOOR_ACTION_CLASSES,
  LEDGER_KINDS,
  LedgerKindSchema,
  MAIL_LABELS,
  MailLabelSchema,
  PROPOSAL_STATUSES,
  ProposalStatusSchema,
  REVERSIBILITIES,
  REVERSIBILITY_BY_ACTION_CLASS,
  ReversibilitySchema,
  RULE_CREATORS,
  RuleCreatorSchema,
  SOURCE_SYSTEMS,
  SourceSystemSchema,
  SYSTEM_MODES,
  SystemModeSchema,
  SYSTEMS,
  SystemSchema,
} from './enums.js';

const enumFixtures = [
  { name: 'LEDGER_KINDS', tuple: LEDGER_KINDS, schema: LedgerKindSchema },
  { name: 'SOURCE_SYSTEMS', tuple: SOURCE_SYSTEMS, schema: SourceSystemSchema },
  { name: 'ACTION_CLASSES', tuple: ACTION_CLASSES, schema: ActionClassSchema },
  { name: 'COUNTERPARTY_CLASSES', tuple: COUNTERPARTY_CLASSES, schema: CounterpartyClassSchema },
  { name: 'SYSTEMS', tuple: SYSTEMS, schema: SystemSchema },
  { name: 'REVERSIBILITIES', tuple: REVERSIBILITIES, schema: ReversibilitySchema },
  { name: 'DECISIONS', tuple: DECISIONS, schema: DecisionSchema },
  { name: 'PROPOSAL_STATUSES', tuple: PROPOSAL_STATUSES, schema: ProposalStatusSchema },
  { name: 'ALERT_SEVERITIES', tuple: ALERT_SEVERITIES, schema: AlertSeveritySchema },
  { name: 'ALERT_STATUSES', tuple: ALERT_STATUSES, schema: AlertStatusSchema },
  { name: 'ALERT_KINDS', tuple: ALERT_KINDS, schema: AlertKindSchema },
  {
    name: 'COMMITMENT_DIRECTIONS',
    tuple: COMMITMENT_DIRECTIONS,
    schema: CommitmentDirectionSchema,
  },
  { name: 'COMMITMENT_STATUSES', tuple: COMMITMENT_STATUSES, schema: CommitmentStatusSchema },
  { name: 'SYSTEM_MODES', tuple: SYSTEM_MODES, schema: SystemModeSchema },
  { name: 'RULE_CREATORS', tuple: RULE_CREATORS, schema: RuleCreatorSchema },
  { name: 'BRIEF_KINDS', tuple: BRIEF_KINDS, schema: BriefKindSchema },
  { name: 'AGENT_RUN_STATUSES', tuple: AGENT_RUN_STATUSES, schema: AgentRunStatusSchema },
  { name: 'MAIL_LABELS', tuple: MAIL_LABELS, schema: MailLabelSchema },
] as const;

describe.each(enumFixtures)('$name', ({ tuple, schema }) => {
  it('has no duplicate values', () => {
    expect(new Set(tuple).size).toBe(tuple.length);
  });

  it('accepts every declared value', () => {
    for (const value of tuple) {
      expect(schema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects a value not in the tuple', () => {
    expect(schema.safeParse('a-value-nobody-declared').success).toBe(false);
  });
});

describe('REVERSIBILITY_BY_ACTION_CLASS', () => {
  it('covers every action class with no extras', () => {
    const covered = Object.keys(REVERSIBILITY_BY_ACTION_CLASS).sort();
    expect(covered).toEqual([...ACTION_CLASSES].sort());
  });

  it('assigns a valid reversibility to every action class', () => {
    for (const actionClass of ACTION_CLASSES) {
      expect(REVERSIBILITIES).toContain(REVERSIBILITY_BY_ACTION_CLASS[actionClass]);
    }
  });

  it('marks the hard-floor action classes irreversible', () => {
    for (const actionClass of HARD_FLOOR_ACTION_CLASSES) {
      expect(REVERSIBILITY_BY_ACTION_CLASS[actionClass]).toBe('irreversible');
    }
  });
});

describe('HARD_FLOOR_ACTION_CLASSES', () => {
  it('is exactly delete, send_email, rule_change and promote_to_shared', () => {
    expect(HARD_FLOOR_ACTION_CLASSES).toEqual([
      'delete',
      'send_email',
      'rule_change',
      'promote_to_shared',
    ]);
  });

  it('contains only known action classes', () => {
    for (const actionClass of HARD_FLOOR_ACTION_CLASSES) {
      expect(ACTION_CLASSES).toContain(actionClass);
    }
  });
});
