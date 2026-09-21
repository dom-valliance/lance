# Runbook: Entra app registration for Lance

Manual, once per environment. Fifteen minutes. Read the "Order of operations" first; it is the part that trips people up.

## Order of operations

Three things reference each other:

- The Entra app registration (this runbook) produces a client id, a tenant id and a client secret.
- The Key Vault, the Postgres Flexible Server and the Container Apps are created by the Bicep deployment in `deploy.md`. They do not exist until that has run.
- The Container Apps read the Entra values as Key Vault references at start.

So: register the app now and keep the three values somewhere safe for the next hour (a password manager, not a file in the repo). Run `deploy.md` steps 1 to 3 to create the environment, including the Key Vault. Then come back to section 5 below and put the values in. Nothing here needs the Key Vault to exist first.

## Values already known for dev

| Item | Value | Where it came from |
|---|---|---|
| Tenant id | `ac995b50-b931-4d4b-b0ea-c0617e8141f9` | `az account show` |
| App registration name | `Lance (Dom)` | Created by Dom 2026-09-20 |
| Client id | `d72a4e64-a707-4387-b7e3-fdfd3e75a64b` | The app registration's Overview page |
| Allowed UPN | `dom@valliance.ai` | Dom's user principal name, the sign-in name in Entra. `az ad signed-in-user show --query userPrincipalName -o tsv` |
| Dom's object id | `19fb2afd-6814-4600-8697-eb798ec5691f` | `az ad signed-in-user show --query id -o tsv`. Already in `infra/params/dev.bicepparam` as the Postgres Entra administrator. |

The client id, tenant id, UPN and object id are identifiers, not secrets, and may live in docs and parameter files. The client secret is the only secret this runbook produces.

## 1. Register the application

Done for dev as `Lance (Dom)`. For another environment: Entra admin centre, App registrations, New registration, single tenant, no redirect URI yet. Record the Application (client) id.

## 2. Redirect URIs

Platform: Web. Add:

- `https://<web-hostname>/api/auth/callback/microsoft-entra-id` for sign-in to the web UI. The hostname is printed by `deploy.md` step 3, so this can be added after the first deploy.
- `http://localhost:3000/api/auth/callback/microsoft-entra-id` for local development of the web UI. Add this now.

The api's delegated Graph consent flow exists from Phase 1. Add its callback too:

- `https://<api-hostname>/auth/graph/callback`, for dev `https://ca-lance-api-dev.graygrass-c682ce2c.uksouth.azurecontainerapps.io/auth/graph/callback`.
- `http://localhost:3001/auth/graph/callback` for local development of the api.

Enable ID tokens under Implicit grant and hybrid flows. Leave access tokens unticked.

## 3. API permissions

Microsoft Graph, delegated:

| Scope | Why |
|---|---|
| `User.Read` | Identity |
| `Mail.ReadWrite` | Read mail, create drafts, apply categories, move to folders |
| `Calendars.ReadWrite` | Read events, create holds |
| `MailboxSettings.Read` | Time zone and working hours |
| `offline_access` | Refresh tokens |

Do not add `Mail.Send`. Its absence is the second lock behind the policy hard floor on sending email. Grant admin consent for the tenant so the first sign-in does not prompt.

## 4. Client secret

Certificates and secrets, New client secret, description `lance-<env>`, expiry 12 months. Copy the value once; it is shown only at creation. Add a calendar reminder for rotation at 11 months and follow `rotate-secrets.md`.

## 5. Key Vault entries

After `deploy.md` step 3 has created the vault (its name is printed by the deployment, `kv-lance-<env>-<suffix>`):

```
KV=<vault name>
az keyvault secret set --vault-name $KV --name entra-tenant-id --value ac995b50-b931-4d4b-b0ea-c0617e8141f9
az keyvault secret set --vault-name $KV --name entra-client-id --value d72a4e64-a707-4387-b7e3-fdfd3e75a64b
az keyvault secret set --vault-name $KV --name entra-client-secret --value '<the secret from step 4>'
az keyvault secret set --vault-name $KV --name allowed-upn --value dom@valliance.ai
```

Keep the secret out of shell history: `read -s SECRET` first, then pass `--value "$SECRET"`.

## 6. Postgres Entra administrator

Nothing to do by hand. The Azure Database for PostgreSQL Flexible Server is the managed Postgres that Bicep creates (`infra/modules/postgres.bicep`), and the template sets Dom as its Entra administrator from `postgresEntraAdminObjectId` and `postgresEntraAdminPrincipalName` in the parameter file. Password authentication is off; Dom signs in to Postgres with an Entra token, which `deploy.md` step 7 shows.

## 7. First delegated consent

The connect route is behind Entra bearer authentication, so it is started from the web app's Settings page: sign in, open Settings and press Connect Microsoft 365. The button goes to the web app's own `/api/graph/connect`, which calls the api with the session's token and forwards the browser to Microsoft; typing the api URL into a browser does not work. Consent once as Dom. The api exchanges the code, stores the refresh token in Key Vault as `graph-refresh-token`, records a `state_changed` ledger event with `change: graph_connected`, and every later refresh rotates the stored token. `/lance status` then shows the Graph connector as connected.
