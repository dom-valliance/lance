# 0021. Slack identity is bound to Entra once, by the user

Date: 2026-09-24
Status: Accepted

## Context

Today one Slack user id, `principals.slack_user_id` or `SLACK_ALLOWED_USER_ID`, may work Lance's commands and buttons. With more than one principal, each Slack user must resolve to exactly one principal, and the binding decides who may approve a proposal. Foundry holds a `slackUserId` for most employees (`docs/plans/ontology.md`, section 1.4).

## Decision

`/lance login` answers with an ephemeral, single-use link bound to the Slack user id, the team id, a nonce and a five-minute expiry, signed with an HMAC. The person follows it, signs in with Entra, and the callback records the binding in `slack_links` with a ledger event. Lance never binds a Slack user from a directory match alone, even where Foundry holds a matching id: the binding has to be proven by the person who holds both accounts. Foundry's value is used only to warn when the proven binding disagrees with it. Every command and interaction resolves its principal from the signed Slack user id through `slack_links`; an unlinked user gets one ephemeral reply pointing at `/lance login`. Slack requests gain a nonce store for replay protection.

## Consequences

A second person cannot act for Dom by knowing his Slack id, and Dom's own binding is re-proven once through `/lance login`. The env var `SLACK_ALLOWED_USER_ID` is retired once Dom has linked.

## Amendment, 2026-09-24 (package 5.4)

`slack_links` has row-level security enabled and not forced, like `principals`: a Slack request is resolved to a principal before it has a scope, so every session reads every row, and the policies hold each write to the principal's own scope. A link is inserted only in the scope of the principal it binds and only active; a principal may revoke or renew their own links and an admin scope may revoke anyone's; column grants keep the Slack user, the team and the principal of a row fixed, and nothing may delete one. `principals.slack_user_id` is no longer set by anyone: a trigger owned by `lance_migrator` fills it from the principal's active link, and the values recorded before links existed were cleared by the migration, since no person proved them.

The link token is `v1.<nonce>.<expiry>.<mac>` and names no Slack id. The MAC is HMAC-SHA256 under a key derived from the Slack signing secret with a label of its own, so no new secret is provisioned; rotating the signing secret voids links outstanding at the time, which last five minutes. The nonce row carries the Slack ids, its expiry is set by the database clock, and its policies let it be consumed once and only before it expires. The request for a link is recorded in the ledger of the principal the Slack user already acts for, or of the organisation's admin (the principal in `DOM_EMAIL`) for someone not yet linked, since an unlinked Slack user has no scope of their own. The web route asks the person to confirm before binding, and names the Slack account, so a link sent to someone else cannot bind silently.

Slack requests carry no Entra token, so each principal's Lance app roles are recorded from their last verified token: at each sign-in when they change, and at the link. `/lance pause all` and `/lance resume all` are gated on `Lance.Admin` as recorded. `SLACK_ALLOWED_USER_ID` still maps to the principal in `DOM_EMAIL`, and only while that principal has no link. The seam for Foundry's `slackUserId` is `DirectorySlackIdsLike` in `apps/api/src/slack/links.ts`, empty until Phase 7.

## Amendment, 2026-09-25 (Phase 5 review)

Confirming on the page proved only that someone with an Entra account pressed Link; it did not prove that the same person ran `/lance login`. A link forwarded to a colleague bound the sender's Slack account to the colleague, revoked the colleague's own link and invited the sender into the colleague's private channel. Three rules close it:

- A link binds only when the Slack profile's email (`users.info`, bot scope `users:read.email`) equals the signing-in principal's UPN, compared without regard to case. No email, or no bot token, refuses the link: the check fails closed.
- A principal with an active link to a different Slack user is refused, and the page says to send `/lance unlink` from that account first. A link never revokes another link as a side effect. `/lance unlink` revokes the sending account's own link with a `slack_unlinked` ledger event.
- Each refusal of these kinds (`taken`, `email_mismatch`, `email_unavailable`, `linked_elsewhere`) is recorded as a `failed` ledger event, `slack_link_refused`, in the ledger of the principal who tried. A refused link is not consumed, so its owner can still use it within its five minutes.

`slack_links` keeps one row per binding, keyed on the Slack user and the time it was linked, with a partial unique index allowing one active binding per Slack user (migration 0019). A revoked binding stays as it was and no longer stops the Slack user being linked again, by any principal whose UPN the Slack email then matches. The policies and column grants of migration 0014 are unchanged.
