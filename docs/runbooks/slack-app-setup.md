# Runbook: Slack app for Lance

Manual, once per workspace. Ten minutes once the api is reachable.

## Order of operations

The manifest carries the api's public hostname, and the bot token and signing secret go into Key Vault. Both come from the Bicep deployment in `deploy.md`, so this runbook runs after `deploy.md` step 3 has stood the environment up. Slack also verifies an Events API request URL at the moment the app is created, which needs the real api image running; Phase 0 uses no events (only the `/lance` slash command and interactivity, neither of which is verified at creation), so the Phase 0 manifest has no event subscription. Phase 1 adds it once the api is live.

Known values:

| Item | Value |
|---|---|
| Channel | `dom-claude-agent`, `C0BU7P278N5` |
| Dom's Slack user id | `U0BN7JN7BAN`, already in `infra/params/dev.bicepparam` as `slackAllowedUserId` |

## 1. Get the api hostname

After `deploy.md` step 3:

```
az containerapp show -g rg-lance-dev -n ca-lance-api-dev --query properties.configuration.ingress.fqdn -o tsv
```

## 2. Create the app from the manifest

1. api.slack.com/apps, Create New App, From a manifest, pick the Valliance workspace.
2. Paste `slack-app-manifest.json` with `<api-hostname>` replaced by the value from step 1. It is the api hostname (`ca-lance-api-...`), not the web one; a command sent to the web app comes back as its sign-in page. Create.

## 3. Install and capture the secrets

1. Install to workspace. Copy the Bot User OAuth Token (`xoxb-...`).
2. Basic Information, App Credentials, copy the Signing Secret.
3. Store both in the vault created by the deployment (name printed by `deploy.md` step 3). Keep the values out of shell history with `read -s`:

```
KV=<vault name>
read -s BOT && az keyvault secret set --vault-name $KV --name slack-bot-token --value "$BOT"
read -s SIGN && az keyvault secret set --vault-name $KV --name slack-signing-secret --value "$SIGN"
```

## 4. Channel

`/invite @Lance` in `dom-claude-agent`. The channel id is configuration, not a secret, and is the default in `packages/shared` config.

## 4a. If the app already exists with the wrong URLs

Slack app settings, Slash Commands, edit `/lance` and set the request URL to `https://<api-hostname>/slack/commands`. Then Interactivity and Shortcuts, set the request URL to `https://<api-hostname>/slack/interactions`. Save each; no reinstall is needed for URL changes.

## 5. Verify

After `deploy.md` step 6 has flipped the apps off the bootstrap image, run `/lance status` in the channel. The api verifies the Slack signature, resolves the user id to a principal through `principals.slack_user_id` (or `SLACK_ALLOWED_USER_ID`, which maps to the principal in `DOM_EMAIL`), and answers with an ephemeral message. Status writes nothing to the ledger. `/lance pause drill` followed by `/lance resume` writes two `state_changed` events, which closes the Phase 0 acceptance criterion.

If Slack shows a timeout, the api is not reachable on its external ingress; check `az containerapp logs show -g rg-lance-dev -n ca-lance-api-dev`.

## 6. Phase 1: events

When the api's event handlers exist, add to the app under Event Subscriptions: request URL `https://<api-hostname>/slack/events`, bot events `message.channels`, `message.groups`, `reaction_added`. Slack verifies the URL then; the api already answers the challenge.

## 7. Retiring the inbox agent

End of Phase 1. Once Lance has posted mail proposals live for five working days, remove the inbox agent's Slack token and record a `state_changed` event with reason `inbox_agent_retired`. The agent-logs watcher keeps reading the channel history for the inbox agent's earlier digests.
