# 0034. Bulk mail skips model triage

Date: 2026-09-24
Status: Accepted

## Context

Spec section 7.1 sends every new observation to triage (Sonnet), after the watcher's Haiku label call. The Phase 5 load test (`docs/runbooks/load-test.md`, 2026-09-24) measured a Monday morning for 30 principals: mail and triage need about 65 minutes of model time at four concurrent calls, and took about two hours because both queues ran one job at a time. Most of that backlog is mail the labeller has already called `Newsletters` or `Notifications`, for which triage almost never proposes anything but the filing the v1 seed rules already describe: `apply_category` by label, and `move_mail` into `AI-Filed` for those two labels (`packages/policy/src/seed.ts`).

## Decision

A mail observation whose only labels are `Newsletters` or `Notifications` does not go to model triage. The watcher runner records it as usual and a deterministic handler proposes what the seed rules cover for those labels: the category for its label, and the move into `AI-Filed`, each through `create_proposal` and the policy engine exactly as triage's proposals are, so policy, the critic, the push budget, dry run and the kill switch treat them the same. Any other label, or a bulk label alongside another label, goes to triage as before. Nothing about the label call changes. The set of bulk labels is configuration, defaulting to those two.

Mail and triage queues also run concurrently, with at most one job per principal at a time, so the model limiter's slots are used and one principal's backlog cannot block another's (load-test option A).

## Consequences

A newsletter no longer yields a commitment, task or alert candidate from triage; the risk-language alert (`risk_language_in_client_mail`) still comes from the label call, which is unchanged. Bulk mail costs one Haiku call instead of one Haiku and one Sonnet call. If a principal finds real work arriving under a bulk label, the fix is the label, not the bypass. The load test is run once more after this change, against the unchanged 60 second queue latency target.
