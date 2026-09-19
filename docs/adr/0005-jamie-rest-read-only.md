# 0005. Jamie via REST API, read-only in v1

Date: 2026-09-19
Status: Accepted

## Context

Spec section 16 Q1 asks whether Jamie is reached through REST or its MCP server. Jamie's official MCP endpoint (`https://mcp.meetjamie.ai/mcp`) authenticates with browser OAuth and dynamic client registration, which does not suit a headless worker. Jamie's REST API (`https://beta-api.meetjamie.ai`, header `x-api-key`, keys prefixed `jk_`) documents list meetings, get meeting, search meetings, delete meeting, list tags and list tasks. It documents no endpoint to create a task, create a tag or add a tag to a meeting. An access and security page covers key scopes and rate limits. Jamie offers webhooks for meeting events through its integrations pages.

Spec section 1.2 lists create Jamie task, create Jamie tag and apply Jamie tag as v1 write actions. ADR 0009 moves all task creation to Notion, which removes the need for Jamie task writes. Dom chose REST on 2026-09-19 because the integration must be deterministic.

## Decision

The Jamie connector uses REST with an API key from Key Vault and exposes reads only: meetings, transcripts (from get meeting), tasks, tags, participants. There is no Jamie write connector, no `FF_JAMIE_WRITES` flag, and the delete endpoint is never wrapped. The API key is created with the narrowest read scope Jamie allows; the connector checks scope at start and refuses a key that can delete. `create_tag` and `apply_tag` remain in the action class enum; the executor rejects them with `unsupported_target`. The Jamie rows are omitted from the policy seed. Webhooks are not used in v1; polling every 15 minutes per spec 7.1.

## Consequences

Jamie tagging from Lance waits for Jamie to ship REST writes; a new ADR then adds the connector and the seed rows. Debrief proposals (spec 10.4) omit Jamie tags. The delete hard floor has a second lock in the key scope, matching the `Mail.Send` pattern in section 4.1.
