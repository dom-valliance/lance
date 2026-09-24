# 0024. Admins see health, never content

Date: 2026-09-24
Status: Accepted

## Context

A `Lance.Admin` (ADR 0020) needs to run the service: see who is onboarded, whether their connectors work, what they cost, and change organisation rules. Row-level security (ADR 0015) scopes every session to one principal; an admin scope may write organisation rows and nothing more.

## Decision

The admin page shows principals with their status and onboarding progress, connector health, the age of each watcher's last run, cost today and this week per principal, changes to organisation-default rules, and system alerts. It reads these through admin procedures that return aggregates and metadata only, computed per principal inside that principal's scope. It never returns another principal's proposals, briefs, commitments, ledger payloads or graph evidence, and there is no delegated review of another person's content in this phase.

## Consequences

An admin cannot read a colleague's mail through Lance. Support questions about content are answered by the principal, not the admin. Every admin procedure has a test that asserts its response carries no content fields.

## Amendment, 2026-09-24 (package 5.6)

The admin procedures are `admin.principals` (status and which onboarding steps are done, from the `state_changed` events each step records, never what was entered), `admin.health` (watcher ages, open breakers, cost, and whether each connector's secret is stored or deleted, as the ledger records it, since the api may write the principal vault and never read it), `admin.ruleChanges` (`rule_changed` events whose `payload.ruleId` names a rule with a null principal), `admin.systemAlerts` (alerts in the admin's own scope that a `system:` actor raised) and two actions. `admin.offboard` records the request in the target's ledger and queues it for the worker, which holds the vault and Slack rights the steps need; an admin cannot offboard themselves. `admin.evidence` is spec 4.4's `GET /admin/evidence?from&to`, built as a mutation so the period travels in the body: an Ed25519-signed bundle, keyed by `evidence-signing-key` in the static vault. Without a principal it covers system events only (access and lifecycle, rule changes, retention runs) across every principal; with one it adds the metadata of that principal's ledger (kind, actor, times, hashes) and no payload or source record id. Each export is recorded in the admin's own ledger as `evidence_exported` with the bundle's digest. System alerts are the admin's own rows, so their titles are shown; every other admin response is tested to carry no content field.
