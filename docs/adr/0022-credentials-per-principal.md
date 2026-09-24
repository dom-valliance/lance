# 0022. Connector credentials are per principal, except Notion

Date: 2026-09-24
Status: Accepted

## Context

Graph, Jamie and (from Phase 7) Foundry credentials belong to one person. Today there is one Graph refresh token in the secret `graph-refresh-token` and one `JAMIE_API_KEY`. Key Vault role assignments are vault-wide except for the Graph token, so the web identity can read every secret; the Phase 0 review deferred this (`docs/adr/0000-phase-log.md`). Role assignments can only be scoped to a secret that exists when the template runs, and a principal's secrets are created at run time, at onboarding.

## Decision

Two vaults. The existing vault keeps the static secrets (Entra, Slack, Anthropic, Notion, Auth.js, the ingest secret), and each app is granted Key Vault Secrets User on exactly the secrets it binds, one assignment per secret; the template creates placeholder secrets so the assignments can be made on the first deploy. A new vault, `kv-lance-p-<env>-<suffix>`, holds per-principal secrets named `graph-refresh-token--<principalId>`, `jamie-api-key--<principalId>` and `foundry-refresh-token--<principalId>`. The worker holds Key Vault Secrets Officer on it (read and rotate). The api holds a custom role whose only data action is `Microsoft.KeyVault/vaults/secrets/setSecret/action`, so onboarding can write a credential it can never read back. The web identity has no role on it. Refresh-token rotation takes a Postgres advisory lock keyed on the principal and the connector, so two worker replicas can never race a rotation. Notion stays one organisation integration, renamed from `Dom's Lance` to `Lance`, because the All Tasks database is shared: reads filter on the principal's Notion user id and writes set that principal as the assignee.

## Consequences

A compromised web container reads no connector credential and no other app's secrets. Adding a static secret means adding its placeholder and its assignment to the template. The worker can scale beyond one replica once the advisory lock has merged.

## Amendment, 2026-09-24: how the template does it

Placeholders never overwrite. ARM has no "create if absent" for a secret: a PUT always writes a new current version. `scripts/deploy.sh` therefore reads the names already in the static vault from the control plane (`scripts/existing-secrets.sh`; names and attributes, never values) immediately before the what-if and the deployment, and passes them through `LANCE_EXISTING_SECRETS`; `infra/modules/keyvault.bicep` creates `lance-placeholder-set-me` only for a secret in `infra/secrets.json` that is not in that list. The parameter files refuse to compile without the variable. A deployment script resource was rejected: it needs its own identity with secret write rights and a storage account, adds a minute per deploy, and would make the same existence check.

One table. `infra/secrets.json` lists each static secret, the env name it binds to, and the apps that bind it or read it through the SDK. `keyvault.bicep` derives one role assignment per (app, secret) from it and `containerapps.bicep` derives the bindings from it, so a binding without its grant cannot be written. Incremental deployments do not delete the vault-wide assignments the old template made, so `scripts/remove-legacy-vault-grants.sh` removes them after each deploy; it finds nothing once they are gone.

The custom role lives in `infra/roles.bicep`, deployed by Dom on a new subscription before the first `main.bicep` deployment and as a module of `infra/deployer.bicep`, which lists its fixed id in `assignableRoleIds`. `setSecret` is sufficient for the SDK's `setSecret`, creating a secret included; it cannot write over a soft-deleted name, which needs `recover`, held by the Secrets Officer roles.

Dom's legacy credentials are copied once, under the rotation lock for Graph, into his own secrets on first use, with a `credential_migrated` ledger event, and the old secrets are never written. The worker keeps Secrets Officer on the legacy `graph-refresh-token` only so a revision of the previous image can finish its last rotation during the deploy. A follow-up removes the copy, that grant, the worker's `KEY_VAULT_URL` and its `jamie-api-key` binding once dev and prod have each recorded both copies; Dom then deletes the two old secrets by hand.

