# Runbook: rotate secrets

Quarterly, and immediately after any suspected exposure. Run `deploy.md` first: this runbook assumes both vaults exist.

There are two vaults (ADR 0022), both created by `infra/main.bicep`:

- The static vault, `kv-lance-<env>-<suffix>` (`infra/modules/keyvault.bicep`), holds the environment's secrets, listed with the apps that read each in `infra/secrets.json`. The Container Apps read them as Key Vault references and pick up a new version on restart. The template created any missing one as the placeholder `lance-placeholder-set-me` and never writes one that exists, so a rotated value survives every deploy.
- The principal vault, `kv-lance-p-<env>-<suffix>` (`infra/modules/principal-vault.bicep`), holds one secret per principal and connector, `<connector secret>--<principalId>`. The api writes them (it cannot read them); the worker reads and rotates them. Nobody sets these by hand.

Read the names first, and echo them:

```
KV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-dev-')].name" -o tsv)
PKV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-dev-')].name" -o tsv)
echo "static=$KV principal=$PKV"
```

For dev these are `kv-lance-dev-j7riq4` and `kv-lance-p-dev-j7riq4`. Store a new value with `az keyvault secret set --vault-name $KV --name <secret> --value "$VALUE"`, after `read -s VALUE` so it stays out of shell history.

## Static secrets

| Secret | Where it is issued | Steps |
|---|---|---|
| `entra-client-secret` | Entra app registration | Create a new secret, store the new version, restart `web`, `api` and `worker`, delete the old secret in Entra after one clean `/lance status`. |
| `auth-secret` | `openssl rand -base64 32` | Store, restart `web`. Every web session is signed out. |
| `slack-bot-token` | Slack app | Reinstall the app to the workspace, store the new token, restart `api` and `worker`. |
| `slack-signing-secret` | Slack app | Regenerate in Basic Information, store, restart `api`. |
| `anthropic-api-key` | Anthropic console | Create a new key, store, restart `worker`, revoke the old key. |
| `notion-token` | Notion integration `Lance` (renamed from `Dom's Lance`; the organisation's one integration) | Refresh the internal integration secret, store, restart `worker`. |
| `agent-log-ingest-secret` | Generated locally | `openssl rand -hex 32`, store, restart `api`, update the sending agents. |
| `graph-refresh-token` | Legacy | Dom's token before ADR 0022, kept only for the one-time copy into his own secret. Do not rotate; it is deleted once the fallback is removed (`deploy.md`, last section). |
| `jamie-api-key` | Legacy | Dom's Jamie key before ADR 0022, bound as `JAMIE_API_KEY` for the one-time copy. Do not rotate; rotate Dom's own key below. |
| Postgres fallback password | Flexible Server | Only if the fallback is in use. Reset in Azure, store, restart all three apps. |

A new static secret is added to `infra/secrets.json` with the apps that bind it; the next deploy creates it as a placeholder and grants exactly those apps, and Dom then sets the value.

## Per-principal secrets

| Secret | Who issues it | Steps |
|---|---|---|
| `graph-refresh-token--<principalId>` | Microsoft Graph, at the principal's consent | Rotated on every use by the worker, under a Postgres advisory lock per principal. To force a new one, the principal opens Settings and presses Connect Microsoft 365; the api writes the new token over the old. |
| `jamie-api-key--<principalId>` | Jamie, Settings, Developers, API Keys (a personal key) | The principal enters the new key in the onboarding form, which calls `POST /credentials/jamie`: the api makes a test call and stores it only if Jamie accepts it. Restart `worker` so it reads the new key, then revoke the old key in Jamie. |
| `foundry-refresh-token--<principalId>` | Reserved for Phase 7 | Nothing writes it yet. |

To see which principals have connected what, list the names (never the values): `az keyvault secret list --vault-name $PKV --query "[].name" -o tsv`. A principal id is the `id` column of `principals`.

A name that was deleted is soft deleted for 90 days, and the api's set-only role cannot write over a soft-deleted name. Recover it first, as Dom or through the worker's role: `az keyvault secret recover --vault-name $PKV --name <secret>`.

After each rotation record a `state_changed` ledger event with reason `secret_rotated:<name>`. The Phase 8 drill runs this runbook end to end and records the timings.
