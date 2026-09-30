# Runbook: Slack app for Lance

Manual, once per workspace. Ten minutes once the api is reachable.

## Order of operations

The manifest carries the api's public hostname, and the bot token and signing secret go into Key Vault. Both come from the Bicep deployment in `deploy.md`, so this runbook runs after `deploy.md` step 3 has stood the environment up. Slack also verifies an Events API request URL at the moment the app is created, which needs the real api image running; Phase 0 uses no events (only the `/lance` slash command and interactivity, neither of which is verified at creation), so the Phase 0 manifest has no event subscription. Phase 1 adds it once the api is live.

Known values:

| Item | Value |
|---|---|
| Workspace | `valliance-ai.slack.com`, team `T0BHX1JPYN8` (Slack `auth.test` with the bot token) |
| App | `Lance`, app id `A0C34BSDZA9`, bot id `B0C2TTK8WT1` (`bots.info`). Its settings open directly at `https://api.slack.com/apps/A0C34BSDZA9/oauth`; if api.slack.com loops on "unknown workspace", sign in to `valliance-ai.slack.com` in the same browser first (2026-09-25) |
| Channel | `dom-claude-agent`, `C0BU7P278N5` |
| Dom's Slack user id | `U0BN7JN7BAN`, linked in dev through `/lance login` on 2026-09-25; `slackAllowedUserId` is empty in `infra/params/dev.bicepparam` (section 8.4) |
| Dev web hostname, where login links land | `ca-lance-web-dev.graygrass-c682ce2c.uksouth.azurecontainerapps.io` (read 2026-09-24 with the command in 8.1) |
| Dev Key Vault | `kv-lance-dev-j7riq4`, the static vault (`az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-dev-')].name" -o tsv`); the principal vault `kv-lance-p-dev-...` beside it holds no Slack secret |

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

After `deploy.md` step 6 has flipped the apps off the bootstrap image, run `/lance status` in the channel. The api verifies the Slack signature, refuses a replayed request, resolves the user id to a principal through `slack_links` (or, until Dom has linked, `SLACK_ALLOWED_USER_ID`, which maps to the principal in `DOM_EMAIL`), and answers with an ephemeral message. A Slack user with no link gets one reply pointing at `/lance login`; section 8 links each person. Status writes nothing to the ledger. `/lance pause drill` followed by `/lance resume` writes two `state_changed` events, which closes the Phase 0 acceptance criterion.

If Slack shows a timeout, the api is not reachable on its external ingress; check `az containerapp logs show -g rg-lance-dev -n ca-lance-api-dev`.

## 6. Phase 1: events

When the api's event handlers exist, add to the app under Event Subscriptions: request URL `https://<api-hostname>/slack/events`, bot events `message.channels`, `message.groups`, `reaction_added`. Slack verifies the URL then; the api already answers the challenge.

## 7. Retiring the inbox agent

End of Phase 1. Once Lance has posted mail proposals live for five working days, remove the inbox agent's Slack token and record a `state_changed` event with reason `inbox_agent_retired`. The agent-logs watcher keeps reading the channel history for the inbox agent's earlier digests.

## 8. Phase 5: link each Slack user and give them a channel (package 5.4)

`/lance login` binds a Slack user to the principal who signs in with Entra (ADR 0021), and the first link gives the principal a private channel, `lance-<first-name>` (ADR 0023). Dom keeps `dom-claude-agent`. Run the steps in this order; each depends on the one before.

### 8.1 Deploy package 5.4 first

Deploy through the pipeline in `deploy.md`. The migration job applies `0014_slack_links` (creates `slack_links`, `slack_link_tokens`, `slack_request_nonces`, and the channel and role columns on `principals`), and `infra/modules/containerapps.bicep` gives the api `PUBLIC_WEB_URL`, the web app's origin that login links point at. Confirm the api has it, and print the web hostname the link will use (it is the web app, `ca-lance-web-...`, not the api):

```
API_WEB_URL=$(az containerapp show -g rg-lance-dev -n ca-lance-api-dev \
  --query "properties.template.containers[0].env[?name=='PUBLIC_WEB_URL'].value | [0]" -o tsv)
echo "$API_WEB_URL"
WEB_FQDN=$(az containerapp show -g rg-lance-dev -n ca-lance-web-dev --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$WEB_FQDN"
```

The two lines must match. Until 8.2 is done, Dom still acts from Slack through `SLACK_ALLOWED_USER_ID`; nobody else can.

### 8.2 Add `groups:write` and reinstall the app

The bot needs `groups:write` to create a private channel and invite the principal (`conversations.create` with `is_private`, `conversations.invite`). No other scope is new: `users:read` (already granted) reads the person's first name for the channel name and their name for the link page, and `chat:write`, `groups:read` and `groups:history` already cover posting to and reading a private channel the bot created.

1. api.slack.com/apps, Lance, App Manifest. Paste `slack-app-manifest.json` with `<api-hostname>` replaced as in section 2, or add `groups:write` under OAuth and Permissions, Bot Token Scopes. The manifest also updates the `/lance` description and usage hint to include `login`.
2. Slack shows a banner asking to reinstall. Reinstall to Workspace and approve.
3. Adding a scope normally keeps the same bot token. If the Bot User OAuth Token shown after reinstalling differs from the one in Key Vault, store it and restart the api and the worker:

```
KV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-dev-')].name | [0]" -o tsv)
echo "$KV"
echo "$KV"
read -s BOT && az keyvault secret set --vault-name "$KV" --name slack-bot-token --value "$BOT"
```

4. Check from Slack's side that the token carries the scope (a read-only call):

```
read -s BOT && curl -s -D - -o /dev/null -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $BOT" | grep -i '^x-oauth-scopes'
```

The line must include `groups:write`.

### 8.3 Dom links first

1. In `dom-claude-agent`, send `/lance login`. The ephemeral reply carries a link to `https://<web-hostname>/link/slack?state=...` that works once, for five minutes.
2. Follow it, sign in with the Valliance Microsoft account, check the Slack account the page names is yours, and press Link this Slack account.
3. The page says Slack is linked and that cards arrive in `C0BU7P278N5`. No channel is created for Dom.
4. From Slack, send `/lance status`: it answers as before, now through the link. Send `/lance pause all` then `/lance resume all` only if you mean to pause everyone; both need `Lance.Admin`, recorded from the token you just signed in with.
5. The Ledger page shows `slack_link_issued`, `slack_linked` and `slack_channel_assigned` as state changes.

If the page says the link expired or was used, send `/lance login` again for a new one.

### 8.4 Retire `SLACK_ALLOWED_USER_ID`

Once 8.3 has succeeded, the api already ignores the variable, because Dom's principal has a link. Remove it through the template, not the portal:

1. In `infra/params/dev.bicepparam` (and `infra/params/prod.bicepparam` when prod is linked), set `param slackAllowedUserId = ''`, commit, and deploy through the pipeline. An empty value is read as unset.
2. Confirm the api carries an empty value:

```
az containerapp show -g rg-lance-dev -n ca-lance-api-dev \
  --query "properties.template.containers[0].env[?name=='SLACK_ALLOWED_USER_ID'].value | [0]" -o tsv
```

3. Send `/lance status` from Slack again; it still answers, through the link.

Removing the parameter and the environment variable from `infra/main.bicep` and `infra/modules/containerapps.bicep` altogether is a later change, once every environment has run 8.3.

### 8.5 Everyone else

Each colleague with a Lance role runs `/lance login` anywhere in Slack and follows the link. Their first link creates `lance-<first-name>` (with `-2`, `-3` and so on when the name is taken) holding them and the bot, and their cards, alerts and briefs arrive there. If Slack refuses the channel, the page says so and the link stands; they run `/lance login` again once the cause is fixed. A button pressed on a card in someone else's channel is refused and raises a P1 `foreign_decision_attempt` alert for the card's owner.

### 8.6 Add `users:read.email` and reinstall the app

A link binds a Slack account only when the Slack profile's email equals the Microsoft account that signs in (ADR 0021), so a link forwarded to someone else binds nobody. The api reads the email with `users.info`, which returns it only when the bot token holds `users:read.email`. Until this step is done, every link is refused with "Slack did not confirm whose account this is", and links made before it stand.

1. api.slack.com/apps, Lance, App Manifest. Paste `slack-app-manifest.json` with `<api-hostname>` replaced as in section 2, or add `users:read.email` under OAuth and Permissions, Bot Token Scopes. The manifest also adds `unlink` to the `/lance` usage hint.
2. Slack shows a banner asking to reinstall. Reinstall to Workspace and approve.
3. If the Bot User OAuth Token shown after reinstalling differs from the one in Key Vault, store it and restart the api and the worker as in 8.2 step 3.
4. Check from Slack's side that the token carries the scope, as in 8.2 step 4. The `x-oauth-scopes` line must include `users:read.email`.
5. Send `/lance login` from your own Slack account and open the link: the page names your Slack account and offers Link this Slack account. A page that says Slack did not confirm whose account this is means the scope is missing from the token the api holds.

### 8.7 Unlinking a Slack account

A principal has one active Slack link. To move to another Slack account, send `/lance unlink` from the account linked now, then `/lance login` from the new one; the ledger records `slack_unlinked` and then `slack_linked`. A link page for the new account refuses with "Your account is linked to another Slack account" until the old link is revoked. A revoked Slack account can later be linked again, by its owner or by whoever its email then belongs to.

If the principal no longer has the old Slack account, `/lance unlink` cannot be sent from it and there is no admin command for one link yet. Offboarding revokes every link of a principal who is leaving (docs/runbooks/offboard-principal.md); for anyone staying, raise it with the lead rather than editing `slack_links` by hand.
