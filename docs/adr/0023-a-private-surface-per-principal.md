# 0023. Each principal has a private surface

Date: 2026-09-24
Status: Accepted

## Context

Lance posts proposal cards, alerts and briefs to one Slack channel, `dom-claude-agent` (C0BU7P278N5), from config. With more than one principal, cards must reach only their owner, and a button press must be honoured only for the proposal's own principal.

## Decision

Each principal gets a private Slack channel holding only them and the bot, created on first link as `lance-<first-name>` with a suffix on collision; its id is stored on the principal. Dom keeps `dom-claude-agent`. Delivery reads the channel from the principal, never from config. A button press is honoured only when the pressing Slack user resolves to the proposal's own principal; any other press is refused with an ephemeral message and raises a P1 `foreign_decision_attempt` alert. The bot gains the `groups:write` scope.

## Consequences

The agent-logs watcher and the audit trail read each principal's channel history the same way. A private channel rather than a direct message keeps that reading uniform (multi-user plan, Q2).

## Amendment, 2026-09-24 (package 5.4)

The channel is created when the link is confirmed, from the api, and stored on the principal from their own scope, once; changing or archiving it is an admin action (offboarding, package 5.6). A failed creation leaves the link in place, is recorded as a `failed` ledger event and is retried by running `/lance login` again. Until Dom links, delivery for the principal in `DOM_EMAIL` falls back to `config.slack.channelId`, which is the channel his link then records; any other principal without a channel has no surface and nothing of theirs is posted. The owner of a card is the principal whose channel it was pressed in, with `dom-claude-agent` mapped to Dom before his link; a press by anyone else raises `foreign_decision_attempt` in the owner's scope. A press that passes still decides in the presser's own scope, where row-level security shows no other principal's proposal.
