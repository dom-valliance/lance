# 0021. Slack identity is bound to Entra once, by the user

Date: 2026-09-24
Status: Accepted

## Context

Today one Slack user id, `principals.slack_user_id` or `SLACK_ALLOWED_USER_ID`, may work Lance's commands and buttons. With more than one principal, each Slack user must resolve to exactly one principal, and the binding decides who may approve a proposal. Foundry holds a `slackUserId` for most employees (`docs/plans/ontology.md`, section 1.4).

## Decision

`/lance login` answers with an ephemeral, single-use link bound to the Slack user id, the team id, a nonce and a five-minute expiry, signed with an HMAC. The person follows it, signs in with Entra, and the callback records the binding in `slack_links` with a ledger event. Lance never binds a Slack user from a directory match alone, even where Foundry holds a matching id: the binding has to be proven by the person who holds both accounts. Foundry's value is used only to warn when the proven binding disagrees with it. Every command and interaction resolves its principal from the signed Slack user id through `slack_links`; an unlinked user gets one ephemeral reply pointing at `/lance login`. Slack requests gain a nonce store for replay protection.

## Consequences

A second person cannot act for Dom by knowing his Slack id, and Dom's own binding is re-proven once through `/lance login`. The env var `SLACK_ALLOWED_USER_ID` is retired once Dom has linked.
