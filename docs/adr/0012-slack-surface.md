# 0012. Lance's own Slack channel is a surface, not a connector write

Date: 2026-09-21
Status: Accepted

## Context

Spec section 8 makes connector write functions callable only from the executor, enforced by an ESLint import boundary. Spec section 9 has Lance post proposal cards, update them when a decision lands, open modals and answer commands, from both the worker (posting) and the api (interaction replies). Those calls are how Lance talks to Dom; they are not actions on an external system that policy governs, and routing them through proposals would make every card a proposal about itself.

## Decision

`packages/connectors` exports a Slack surface from its root: post, update, ephemeral and open modal, pinned at construction to Lance's own channel from config and to the bot token. It cannot post anywhere else. The `writes` entry point keeps the connector writes policy governs: Graph and Notion in Phase 1, and `post_slack` to any other channel if that is ever proposed. The seed rule granting `post_slack` auto for Lance's own channel remains, for the case where a model proposes a post.

## Consequences

The worker's proposal router and the api's interaction handler import the surface without crossing the executor boundary. A future connector write to Slack outside Lance's channel goes through `writes` and the executor like any other. The boundary test in `packages/shared` stays as it is.

## Amendment, 2026-09-24 (package 5.4)

With a private channel per principal (ADR 0023), each principal's surface is pinned to that principal's channel rather than to the channel in config; it still cannot post anywhere else. Creating a principal's private channel and inviting them are Lance's own surface management in the same sense, so `createSlackChannelProvisioner` sits beside the surface in the package root and is used by the api when a link is confirmed. It posts nothing. The `post_slack` seed rule still names the config channel; a model-proposed post to a principal's own channel is outside this package.
