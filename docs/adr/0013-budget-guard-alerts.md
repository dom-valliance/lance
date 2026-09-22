# 0013. Budget guard alerts share the cost_spike kind

Date: 2026-09-22
Status: Accepted

## Context

Spec section 11 lists `cost_spike` as an alert kind: a day's model spend well above the trailing average. Spec section 13 adds a daily cost ceiling with two thresholds, a warning at 80 percent and a hard stop at 100 percent, and says each raises an alert, without naming a kind. The alert kind enum is shared between the worker, the api and the web app, and adding a kind means a migration of the enum and a release of all three.

## Decision

The budget guard detector raises both thresholds under the kind `cost_spike`, with dedupe keys that carry the threshold and the day: `budget:80:<date>` for the warning at P1 and `budget:100:<date>` for the stop at P0. The title and body say which threshold fired. The trailing-average detector keeps its own key, `cost:<date>`, so a day can carry all three alerts.

## Consequences

- Filtering the Alerts page by `cost_spike` shows spend problems of both sorts together, which is the view Dom wants when cost is the question.
- The dedupe key is the discriminator. Anything that needs to tell the guard from the trailing-average detector, such as the weekly review's alerts-by-kind table, reads the key prefix.
- If a later phase needs the distinction in the kind itself, the enum gains `budget_warning` and `budget_exceeded` and the guard's keys stay as they are, so history remains readable.
