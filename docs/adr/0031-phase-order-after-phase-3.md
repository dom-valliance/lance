# 0031. Phase order after Phase 3

Date: 2026-09-23
Status: Accepted

## Context

Spec section 15 puts ontology and autonomy in Phase 4 and hardening in Phase 5, and treats multi-user as out of scope for v1 (section 1.3). On 23 September Dom added three briefings, now in `docs/plans/`: `ontology.md` (principal seam, Foundry reference layer, earned autonomy), `multi-user.md` (tracks M1 to M8) and `jobs.md` (tracks J1 to J8). Each briefing assumes the ontology comes first. Dom chose to build multi-user and jobs before the reference ontology.

## Decision

Phases 4 to 8 follow `docs/plans/roadmap.md`: Phase 4 principal seam (ontology WP4.1, WP4.3, policy tiers and `promote_to_shared`), Phase 5 multi-user (M1 to M7, with M5 and J1 built as one scheduler package), a pilot of one colleague once Phase 5 is accepted and the framework workshop has been held, Phase 6 jobs (J2 to J8), Phase 7 ontology and autonomy (Foundry, attribution, the Ontology and Policies pages, shadow mode, promotion and demotion), Phase 8 hardening. The roadmap keeps the briefings' scope, design and acceptance criteria and changes only order and dependencies. The ADR numbers the briefings reserve (0015 to 0030) are kept and written in build order.

## Consequences

A second principal can run before Lance has reference data, so the pilot colleague's counterparties resolve to `unknown` and every proposal needs approval; that is the safe direction. Onboarding gains its Foundry step, jobs gain `foundry.*` inputs, and job event filters gain organisation type and project only in Phase 7. Per-secret Key Vault scoping, the Slack nonce store, the refresh-token lock, the data map and the LIA move from hardening into Phase 5, because a second principal turns each into a defect. The framework workshop in the week of 6 October may change the multiplayer model; if it does, `multi-user.md` is amended before the pilot and this ADR is revisited.
