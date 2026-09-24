# 0022. Connector credentials are per principal, except Notion

Date: 2026-09-24
Status: Accepted

## Context

Graph, Jamie and (from Phase 7) Foundry credentials belong to one person. Today there is one Graph refresh token in the secret `graph-refresh-token` and one `JAMIE_API_KEY`. Key Vault role assignments are vault-wide except for the Graph token, so the web identity can read every secret; the Phase 0 review deferred this (`docs/adr/0000-phase-log.md`). Role assignments can only be scoped to a secret that exists when the template runs, and a principal's secrets are created at run time, at onboarding.

## Decision

Two vaults. The existing vault keeps the static secrets (Entra, Slack, Anthropic, Notion, Auth.js, the ingest secret), and each app is granted Key Vault Secrets User on exactly the secrets it binds, one assignment per secret; the template creates placeholder secrets so the assignments can be made on the first deploy. A new vault, `kv-lance-p-<env>-<suffix>`, holds per-principal secrets named `graph-refresh-token--<principalId>`, `jamie-api-key--<principalId>` and `foundry-refresh-token--<principalId>`. The worker holds Key Vault Secrets Officer on it (read and rotate). The api holds a custom role whose only data action is `Microsoft.KeyVault/vaults/secrets/setSecret/action`, so onboarding can write a credential it can never read back. The web identity has no role on it. Refresh-token rotation takes a Postgres advisory lock keyed on the principal and the connector, so two worker replicas can never race a rotation. Notion stays one organisation integration, renamed from `Dom's Lance` to `Lance`, because the All Tasks database is shared: reads filter on the principal's Notion user id and writes set that principal as the assignee.

## Consequences

A compromised web container reads no connector credential and no other app's secrets. Adding a static secret means adding its placeholder and its assignment to the template. The worker can scale beyond one replica once the advisory lock has merged.
