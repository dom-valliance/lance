# Runbook: Slack app for Lance

Manual, once per workspace. Ten minutes.

## 1. Create from manifest

1. api.slack.com/apps, Create New App, From a manifest.
2. Pick the Valliance workspace. Paste [slack-app-manifest.json](slack-app-manifest.json), replacing `<api-hostname>` with the api Container App's external hostname.
3. Create.

## 2. Install and record secrets

1. Install to workspace. Copy the Bot User OAuth Token (`xoxb-...`).
2. Basic Information, App Credentials, copy the Signing Secret.
3. Store both in Key Vault:

| Secret name | Value |
|---|---|
| `slack-bot-token` | `xoxb-...` |
| `slack-signing-secret` | Signing secret |

## 3. Channel

Invite the bot to `dom-claude-agent` (C0BU7P278N5): `/invite @Lance`. The channel id is config, not a secret: `SLACK_CHANNEL_ID=C0BU7P278N5`. Record Dom's Slack user id in `users.slack_user_id`.

## 4. Verify

Run `/lance status` in the channel. The api verifies the signature, answers with an ephemeral message, and the ledger shows a `state_changed` event for the first command. If Slack reports a URL verification failure, the api is not reachable on the path-scoped external ingress; check the Bicep ingress rules.

## 5. Retiring the inbox agent

End of Phase 1. Once Lance has posted mail proposals live for five working days, remove the inbox agent's Slack token and record a `state_changed` event with reason `inbox_agent_retired`. The agent-logs watcher keeps reading the channel history for the inbox agent's earlier digests.
