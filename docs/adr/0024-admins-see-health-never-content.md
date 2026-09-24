# 0024. Admins see health, never content

Date: 2026-09-24
Status: Accepted

## Context

A `Lance.Admin` (ADR 0020) needs to run the service: see who is onboarded, whether their connectors work, what they cost, and change organisation rules. Row-level security (ADR 0015) scopes every session to one principal; an admin scope may write organisation rows and nothing more.

## Decision

The admin page shows principals with their status and onboarding progress, connector health, the age of each watcher's last run, cost today and this week per principal, changes to organisation-default rules, and system alerts. It reads these through admin procedures that return aggregates and metadata only, computed per principal inside that principal's scope. It never returns another principal's proposals, briefs, commitments, ledger payloads or graph evidence, and there is no delegated review of another person's content in this phase.

## Consequences

An admin cannot read a colleague's mail through Lance. Support questions about content are answered by the principal, not the admin. Every admin procedure has a test that asserts its response carries no content fields.
