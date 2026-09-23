# 0019. Policy evaluates in tiers

Date: 2026-09-23
Status: Accepted

## Context

Spec section 6.2 selects the most specific active rule, with hard floors first and `propose` when nothing matches. With more than one principal, some rules belong to one person (an `auto` cell Dom earned) and some to the organisation (the v1 seed rules). The Phase 4 briefing (`docs/plans/ontology.md`, sections 3 and 5) asks for tiers. ADR 0015 adds a nullable `principal_id` to `policy_rules`, where null means an organisation default, and row-level security shows each principal their own rules plus the organisation's.

## Decision

Evaluation order:

1. Hard floors, in code. `delete` and `send_email` resolve to `forbid`. `rule_change` and the new `promote_to_shared` resolve to `propose`; a matching `forbid` rule may tighten them, and nothing loosens them.
2. The organisation's `forbid` ceiling. If the most specific matching organisation rule is `forbid`, the result is `forbid`, whatever a personal rule says.
3. Personal rules. The most specific matching rule whose `principal_id` is the caller's decides, by the spec 6.2 specificity order.
4. Organisation defaults. The most specific matching rule with a null `principal_id` decides.
5. `propose`.

Conditions on an `auto` rule still downgrade to `propose` (spec 6.2 step 4), whichever tier the rule came from. `EvaluationResult` records the tier that decided. The v1 seed rules become organisation defaults in the ADR 0015 migration. Promotion (Phase 7) writes personal rules only. Changing an organisation default needs an admin-scoped session.

## Consequences

A principal can be granted more autonomy than the organisation default without changing anyone else's cells, and can never be granted anything the organisation forbids. `packages/policy` keeps 100% branch coverage. The property suite gains three cases: no personal rule lifts a hard floor, no personal rule overrides a stricter organisation `forbid`, and `promote_to_shared` never resolves to `auto`.
