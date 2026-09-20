import {
  ACTION_CLASSES,
  COUNTERPARTY_CLASSES,
  DECISIONS,
  HARD_FLOOR_ACTION_CLASSES,
  PolicyInputSchema,
  RULE_CREATORS,
  SYSTEMS,
  type ActionClass,
  type CounterpartyClass,
  type PolicyInput,
  type PolicyRule,
  type System,
} from '@lance/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, type PolicyInputCandidate } from './evaluate.js';
import { seedRules } from './seed.js';
import { ruleMatches, specificityOf } from './specificity.js';
import { seedLikeId, T0 } from './testing.js';
import { PolicyRuleValidationError, validateRule } from './validateRule.js';

/**
 * Property-based tests for the policy engine.
 *
 * The rule arbitraries build rules straight from `PolicyRuleSchema`'s shape and
 * never go through `validateRule`, so the generated rule sets are hostile on
 * purpose: auto on a delete, auto on a wildcard action class, inactive rules
 * and several rules on one cell all appear. Evaluation must hold regardless.
 */

const RUNS = 500;

/** Crockford base32, the alphabet `UlidSchema` accepts. */
const CROCKFORD_DIGITS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

const HARD_FLOOR_SET: ReadonlySet<string> = new Set(HARD_FLOOR_ACTION_CLASSES);

/** Timestamps a rule may carry. Distinct values so createdAt can break a tie. */
const CREATED_AT = [
  '2025-01-02T09:00:00.000Z',
  '2026-01-05T07:30:00.000Z',
  '2026-09-21T10:00:00.000Z',
] as const;

/**
 * Evaluation times spanning weekdays, weekends and both sides of the 07:00 and
 * 19:00 Europe/London working-hours boundaries, in GMT and in BST.
 */
const AT_TIMESTAMPS = [
  '2026-09-21T05:59:00.000Z', // Monday 06:59 London, before the start boundary
  '2026-09-21T06:00:00.000Z', // Monday 07:00 London, the inclusive start
  '2026-09-21T10:00:00.000Z', // Monday 11:00 London, mid working day
  '2026-09-21T17:59:00.000Z', // Monday 18:59 London, before the end boundary
  '2026-09-21T18:00:00.000Z', // Monday 19:00 London, the exclusive end
  '2026-09-26T10:00:00.000Z', // Saturday 11:00 London
  '2026-09-27T10:00:00.000Z', // Sunday 11:00 London
  '2026-01-05T06:30:00.000Z', // Monday 06:30 London in GMT
  '2026-01-05T07:30:00.000Z', // Monday 07:30 London in GMT
  '2026-09-22T11:00:00+01:00', // Tuesday 11:00 London, written with an offset
] as const;

const SHORT_STRINGS = [
  'Newsletters',
  'Notifications',
  'Deals',
  'Action',
  'AI-Filed',
  'Archive',
  'C0BU7P278N5',
] as const;

const ulidArb = fc
  .array(fc.constantFrom(...CROCKFORD_DIGITS), { minLength: 26, maxLength: 26 })
  .map((digits) => digits.join(''));

/** A dimension value, wildcarded with roughly one third probability. */
function wildcardable<T extends string>(values: readonly T[]): fc.Arbitrary<T | '*'> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant('*' as const) },
    { weight: 2, arbitrary: fc.constantFrom(...values) },
  );
}

/**
 * The same shape, but a third of the weight goes to the value the input under
 * test carries. Drawing rule dimensions independently of the input leaves
 * roughly nine runs in ten with no matching rule at all, which leaves rule
 * selection and the condition checks all but unexercised.
 */
function cellDimension<T extends string>(
  values: readonly T[],
  preferred: T,
): fc.Arbitrary<T | '*'> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant('*' as const) },
    { weight: 1, arbitrary: fc.constant(preferred) },
    { weight: 1, arbitrary: fc.constantFrom(...values) },
  );
}

const shortStringsArb = fc.uniqueArray(fc.constantFrom(...SHORT_STRINGS), {
  minLength: 1,
  maxLength: 3,
});

const conditionsArb = fc.record(
  {
    withinWorkingHours: fc.boolean(),
    maxPerDay: fc.integer({ min: 1, max: 5 }),
    maxPerHour: fc.integer({ min: 1, max: 5 }),
    requireCriticPass: fc.boolean(),
    minConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
    labelsAnyOf: shortStringsArb,
    targetAnyOf: shortStringsArb,
  },
  { requiredKeys: [] },
);

function ruleArbOver(
  actionClass: fc.Arbitrary<ActionClass | '*'>,
  counterpartyClass: fc.Arbitrary<CounterpartyClass | '*'>,
  system: fc.Arbitrary<System | '*'>,
): fc.Arbitrary<PolicyRule> {
  return fc
    .record(
      {
        id: ulidArb,
        version: fc.integer({ min: 1, max: 5 }),
        active: fc.boolean(),
        actionClass,
        counterpartyClass,
        system,
        decision: fc.constantFrom(...DECISIONS),
        conditions: conditionsArb,
        createdBy: fc.constantFrom(...RULE_CREATORS),
        createdAt: fc.constantFrom(...CREATED_AT),
        rationale: fc.constantFrom('generated rule', 'property rule'),
      },
      {
        requiredKeys: [
          'id',
          'version',
          'active',
          'actionClass',
          'counterpartyClass',
          'system',
          'decision',
          'createdBy',
          'createdAt',
          'rationale',
        ],
      },
    )
    .map((candidate): PolicyRule => candidate);
}

/** Ids stay unique across a rule set so that rule selection is a total order. */
function ruleSetArbOver(arb: fc.Arbitrary<PolicyRule>): fc.Arbitrary<PolicyRule[]> {
  return fc.uniqueArray(arb, {
    minLength: 1,
    maxLength: 6,
    selector: (candidate) => candidate.id,
    comparator: (a, b) => a === b,
  });
}

const ruleArb = ruleArbOver(
  wildcardable(ACTION_CLASSES),
  wildcardable(COUNTERPARTY_CLASSES),
  wildcardable(SYSTEMS),
);

const inputArb = fc
  .record(
    {
      actionClass: fc.constantFrom(...ACTION_CLASSES),
      counterpartyClass: fc.constantFrom(...COUNTERPARTY_CLASSES),
      system: fc.constantFrom(...SYSTEMS),
      at: fc.constantFrom(...AT_TIMESTAMPS),
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      criticPassed: fc.boolean(),
      countsToday: fc.nat({ max: 8 }),
      countsThisHour: fc.nat({ max: 8 }),
      labels: fc.uniqueArray(fc.constantFrom(...SHORT_STRINGS), { maxLength: 3 }),
      target: fc.constantFrom(...SHORT_STRINGS),
      stage: fc.constantFrom('proposal' as const, 'execution' as const),
    },
    { requiredKeys: ['actionClass', 'counterpartyClass', 'system', 'at'] },
  )
  .map((candidate): PolicyInputCandidate => candidate);

interface Scenario {
  readonly raw: PolicyInputCandidate;
  readonly parsed: PolicyInput;
  readonly rules: PolicyRule[];
}

/** An input paired with a rule set weighted towards that input's cell. */
const scenarioArb: fc.Arbitrary<Scenario> = inputArb.chain((raw) => {
  const parsed = PolicyInputSchema.parse(raw);
  return ruleSetArbOver(
    ruleArbOver(
      cellDimension(ACTION_CLASSES, parsed.actionClass),
      cellDimension(COUNTERPARTY_CLASSES, parsed.counterpartyClass),
      cellDimension(SYSTEMS, parsed.system),
    ),
  ).map((rules) => ({ raw, parsed, rules }));
});

/** A rule whose three dimensions name the input's cell exactly. */
function ruleForCell(
  parsed: PolicyInput,
  overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id'>,
): PolicyRule {
  return {
    version: 1,
    active: true,
    actionClass: parsed.actionClass,
    counterpartyClass: parsed.counterpartyClass,
    system: parsed.system,
    decision: 'auto',
    createdBy: 'user:dom',
    createdAt: T0,
    rationale: 'cell rule',
    ...overrides,
  };
}

describe('policy engine properties', () => {
  it('resolves every hard floor action class by floor alone, whatever the rules say', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.constantFrom(...HARD_FLOOR_ACTION_CLASSES),
        ({ raw, rules }, actionClass) => {
          const result = evaluate({ ...raw, actionClass }, rules);
          expect(result.unmetConditions).toEqual([]);
          if (actionClass === 'rule_change' && result.reason === 'rule_matched') {
            // The propose floor may be tightened by a matching forbid rule, never loosened.
            expect(result.decision).toBe('forbid');
            expect(rules.find((rule) => rule.id === result.ruleId)?.decision).toBe('forbid');
            return;
          }
          expect(result.reason).toBe('hard_floor');
          expect(result.decision).toBe(actionClass === 'rule_change' ? 'propose' : 'forbid');
          expect(result.ruleId).toBeNull();
          expect(result.specificity).toBeNull();
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('returns a result whose reason agrees with its rule id, decision and unmet conditions', () => {
    fc.assert(
      fc.property(scenarioArb, ({ raw, rules }) => {
        const result = evaluate(raw, rules);
        expect(DECISIONS).toContain(result.decision);
        expect(result.ruleId === null).toBe(
          result.reason === 'hard_floor' || result.reason === 'no_matching_rule',
        );
        expect(result.unmetConditions.length > 0).toBe(result.reason === 'conditions_unmet');
        if (result.reason === 'conditions_unmet') expect(result.decision).not.toBe('forbid');
      }),
      { numRuns: RUNS },
    );
  });

  it('names the most specific active matching rule, breaking ties towards the newest version', () => {
    fc.assert(
      fc.property(scenarioArb, ({ raw, parsed, rules }) => {
        const result = evaluate(raw, rules);
        fc.pre(result.reason === 'rule_matched' || result.reason === 'conditions_unmet');
        const winner = rules.find((candidate) => candidate.id === result.ruleId);
        expect(winner).toBeDefined();
        if (winner === undefined) return;
        expect(winner.active).toBe(true);
        expect(ruleMatches(winner, parsed)).toBe(true);
        for (const other of rules) {
          if (other.id === winner.id || !ruleMatches(other, parsed)) continue;
          expect(specificityOf(other)).toBeLessThanOrEqual(specificityOf(winner));
          if (specificityOf(other) === specificityOf(winner)) {
            expect(other.version).toBeLessThanOrEqual(winner.version);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('ignores a rule that does not match the input', () => {
    fc.assert(
      fc.property(scenarioArb, ruleArb, ({ raw, parsed, rules }, extra) => {
        fc.pre(!ruleMatches(extra, parsed));
        fc.pre(!rules.some((candidate) => candidate.id === extra.id));
        expect(evaluate(raw, [...rules, extra])).toEqual(evaluate(raw, rules));
      }),
      { numRuns: RUNS },
    );
  });

  it('treats deactivating the winning rule as removing it and grants auto only to an active auto rule', () => {
    fc.assert(
      fc.property(scenarioArb, ({ raw, parsed, rules }) => {
        const result = evaluate(raw, rules);
        fc.pre(result.ruleId !== null);
        const withoutWinner = rules.filter((candidate) => candidate.id !== result.ruleId);
        const deactivated = rules.map((candidate) =>
          candidate.id === result.ruleId ? { ...candidate, active: false } : candidate,
        );
        const afterDeactivation = evaluate(raw, deactivated);
        expect(afterDeactivation).toEqual(evaluate(raw, withoutWinner));
        if (afterDeactivation.decision === 'auto') {
          expect(
            withoutWinner.some(
              (candidate) => candidate.decision === 'auto' && ruleMatches(candidate, parsed),
            ),
          ).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('rejects a rule granting auto to a hard floor or to a wildcard action class', () => {
    fc.assert(
      fc.property(ruleArb, (candidate) => {
        fc.pre(
          candidate.decision === 'auto' &&
            (candidate.actionClass === '*' || HARD_FLOOR_SET.has(candidate.actionClass)),
        );
        expect(() => validateRule(candidate)).toThrow(PolicyRuleValidationError);
      }),
      { numRuns: RUNS },
    );
  });

  it('accepts every other well-formed rule unchanged', () => {
    fc.assert(
      fc.property(ruleArb, (candidate) => {
        fc.pre(
          !(
            candidate.decision === 'auto' &&
            (candidate.actionClass === '*' || HARD_FLOOR_SET.has(candidate.actionClass))
          ),
        );
        expect(validateRule(candidate)).toEqual(candidate);
      }),
      { numRuns: RUNS },
    );
  });

  it('gives the same result whatever order the rules arrive in', () => {
    const shuffledScenarioArb = scenarioArb.chain((scenario) =>
      fc
        .shuffledSubarray(scenario.rules, {
          minLength: scenario.rules.length,
          maxLength: scenario.rules.length,
        })
        .map((shuffled) => ({ scenario, shuffled })),
    );
    fc.assert(
      fc.property(shuffledScenarioArb, ({ scenario, shuffled }) => {
        expect(evaluate(scenario.raw, shuffled)).toEqual(evaluate(scenario.raw, scenario.rules));
      }),
      { numRuns: RUNS },
    );
  });

  it('never reports an unmet critic pass on an auto rule that waives it', () => {
    fc.assert(
      fc.property(scenarioArb, ruleArb, ({ raw, parsed }, candidate) => {
        fc.pre(!HARD_FLOOR_SET.has(parsed.actionClass));
        const waived = ruleForCell(parsed, {
          id: candidate.id,
          conditions: { ...(candidate.conditions ?? {}), requireCriticPass: false },
        });
        const result = evaluate(raw, [waived]);
        expect(result.unmetConditions).not.toContain('requireCriticPass');
        expect(result.requiresCriticPass).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('downgrades an auto rule with default conditions when the critic failed', () => {
    fc.assert(
      fc.property(scenarioArb, ({ raw, parsed }) => {
        fc.pre(!HARD_FLOOR_SET.has(parsed.actionClass));
        const auto = ruleForCell(parsed, { id: seedLikeId(1) });
        const result = evaluate({ ...raw, criticPassed: false }, [auto]);
        expect(result.decision).toBe('propose');
        expect(result.reason).toBe('conditions_unmet');
        expect(result.unmetConditions).toContain('requireCriticPass');
        expect(result.requiresCriticPass).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

const SEED_CHANNEL = 'C0BU7P278N5';
const SEED_LABELS = ['Newsletters', 'Notifications'];
const SEED_AUTO_CLASSES = ['read', 'classify', 'apply_category', 'move_mail', 'post_slack'];

interface SeedVariant {
  readonly name: string;
  readonly labels?: readonly string[];
  readonly target?: string;
}

const SEED_VARIANTS: readonly SeedVariant[] = [
  { name: 'no labels and no target' },
  { name: 'a Newsletters label filed into AI-Filed', labels: ['Newsletters'], target: 'AI-Filed' },
  {
    name: 'a Notifications label filed into AI-Filed',
    labels: ['Notifications'],
    target: 'AI-Filed',
  },
  { name: 'a Deals label filed into Archive', labels: ['Deals'], target: 'Archive' },
  { name: "Lance's own Slack channel as the target", target: SEED_CHANNEL },
];

/** The cells and inputs the seed rules are meant to grant auto to, and no others. */
function seedShouldGrantAuto(
  actionClass: ActionClass,
  counterpartyClass: CounterpartyClass,
  system: System,
  variant: SeedVariant,
): boolean {
  const labelled = variant.labels?.some((label) => SEED_LABELS.includes(label)) ?? false;
  switch (actionClass) {
    case 'read':
    case 'classify':
      return true;
    case 'apply_category':
      return system === 'graph' && labelled;
    case 'move_mail':
      return system === 'graph' && labelled && variant.target === 'AI-Filed';
    case 'post_slack':
      return counterpartyClass === 'self' && system === 'slack' && variant.target === SEED_CHANNEL;
    default:
      return false;
  }
}

describe('seed rules over every cell', () => {
  const rules = seedRules({ slackChannelId: SEED_CHANNEL, createdAt: T0 });
  const autoClasses = new Set<ActionClass>();
  const missingAuto: string[] = [];
  const unexpectedAuto: string[] = [];
  let cells = 0;

  for (const actionClass of ACTION_CLASSES) {
    for (const counterpartyClass of COUNTERPARTY_CLASSES) {
      for (const system of SYSTEMS) {
        cells += 1;
        for (const variant of SEED_VARIANTS) {
          const raw: PolicyInputCandidate = {
            actionClass,
            counterpartyClass,
            system,
            at: T0,
            ...(variant.labels === undefined ? {} : { labels: [...variant.labels] }),
            ...(variant.target === undefined ? {} : { target: variant.target }),
          };
          const result = evaluate(raw, rules);
          const cell = `${actionClass}/${counterpartyClass}/${system} with ${variant.name}`;
          if (result.decision === 'auto') autoClasses.add(actionClass);
          const expected = seedShouldGrantAuto(actionClass, counterpartyClass, system, variant);
          if (expected && result.decision !== 'auto') missingAuto.push(cell);
          if (!expected && result.decision === 'auto') unexpectedAuto.push(cell);
        }
      }
    }
  }

  it('covers every action class, counterparty class and system combination', () => {
    expect(ACTION_CLASSES.length * COUNTERPARTY_CLASSES.length * SYSTEMS.length).toBe(525);
    expect(cells).toBe(525);
  });

  it('grants auto exactly where the seed conditions demand it', () => {
    expect(unexpectedAuto).toEqual([]);
    expect(missingAuto).toEqual([]);
  });

  it('never grants auto to a hard floor action class', () => {
    for (const actionClass of HARD_FLOOR_ACTION_CLASSES) {
      expect(autoClasses.has(actionClass)).toBe(false);
    }
  });

  it('grants auto only to reads, classification, categorisation, filing and its own Slack channel', () => {
    expect([...autoClasses].sort()).toEqual([...SEED_AUTO_CLASSES].sort());
  });
});
