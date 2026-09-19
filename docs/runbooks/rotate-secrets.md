# Runbook: rotate secrets

Quarterly, and immediately after any suspected exposure. All secrets are Key Vault references; Container Apps pick up new versions on restart.

| Secret | Where it is issued | Steps |
|---|---|---|
| `entra-client-secret` | Entra app registration | Create a new secret, store the new version in Key Vault, restart `api` and `worker`, delete the old secret in Entra after one clean `/lance status`. |
| `graph-refresh-token` | Issued by Graph on consent | Rotated on every use automatically. To force: delete the Key Vault version, open `/auth/graph/connect` as Dom, consent. |
| `slack-bot-token` | Slack app | Reinstall the app to the workspace, store the new token, restart `api`. |
| `slack-signing-secret` | Slack app | Regenerate in Basic Information, store, restart `api`. |
| `anthropic-api-key` | Anthropic console | Create a new key, store, restart `worker`, revoke the old key. |
| `notion-token` | Notion integration settings | Refresh the internal integration secret, store, restart `worker`. |
| `jamie-api-key` | Jamie settings | Create a new read-only key, store, restart `worker`, revoke the old key. |
| `agent-log-ingest-secret` | Generated locally | `openssl rand -hex 32`, store, restart `api`, update the sending agents. |
| Postgres fallback password | Flexible Server | Only if the fallback is in use. Reset in Azure, store, restart all three apps. |

After each rotation record a `state_changed` ledger event with reason `secret_rotated:<name>`. The Phase 5 drill runs this runbook end to end and records the timings.
