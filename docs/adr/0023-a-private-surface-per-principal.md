# 0023. Each principal has a private surface

Date: 2026-09-24
Status: Accepted

## Context

Lance posts proposal cards, alerts and briefs to one Slack channel, `dom-claude-agent` (C0BU7P278N5), from config. With more than one principal, cards must reach only their owner, and a button press must be honoured only for the proposal's own principal.

## Decision

Each principal gets a private Slack channel holding only them and the bot, created on first link as `lance-<first-name>` with a suffix on collision; its id is stored on the principal. Dom keeps `dom-claude-agent`. Delivery reads the channel from the principal, never from config. A button press is honoured only when the pressing Slack user resolves to the proposal's own principal; any other press is refused with an ephemeral message and raises a P1 `foreign_decision_attempt` alert. The bot gains the `groups:write` scope.

## Consequences

The agent-logs watcher and the audit trail read each principal's channel history the same way. A private channel rather than a direct message keeps that reading uniform (multi-user plan, Q2).
