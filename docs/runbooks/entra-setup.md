# Runbook: Entra app registration for Lance

Manual, once per environment. Fifteen minutes. Read the "Order of operations" first; it is the part that trips people up.

## Order of operations

Three things reference each other:

- The Entra app registration (this runbook) produces a client id, a tenant id and a client secret.
- The Key Vault, the Postgres Flexible Server and the Container Apps are created by the Bicep deployment in `deploy.md`. They do not exist until that has run.
- The Container Apps read the Entra values as Key Vault references at start.

So: register the app now and keep the three values somewhere safe for the next hour (a password manager, not a file in the repo). Run `deploy.md` steps 1 to 3 to create the environment, including the Key Vault. Then come back to section 5 below and put the values in. Sections 1 to 4 need nothing else to exist first.

Section 8 (app roles and groups, ADR 0020) comes last: it reads the client id from the Key Vault that section 5 filled, so it runs after `deploy.md` step 4 and after section 5.

## Values already known for dev

| Item | Value | Where it came from |
|---|---|---|
| Tenant id | `ac995b50-b931-4d4b-b0ea-c0617e8141f9` | `az account show` |
| App registration name | `Lance (Dom)` until section 8 runs, then `Lance (Valliance)` | Created by Dom 2026-09-20; renamed by `scripts/entra/setup-app-roles.sh` |
| Client id | `d72a4e64-a707-4387-b7e3-fdfd3e75a64b` | The app registration's Overview page, or Key Vault secret `entra-client-id` |
| App registration object id | `f5d39a38-95f7-43b1-995c-4dbf1b8fd0c7` | `az ad app show --id <client id> --query id -o tsv` |
| Service principal object id | `6a1e3a1b-e37e-44fc-aa47-a30fa68f2c80` | `az ad sp show --id <client id> --query id -o tsv` |
| Dom's UPN | `dom@valliance.ai` | `az ad signed-in-user show --query userPrincipalName -o tsv`. The principal the ingest webhook and `SLACK_ALLOWED_USER_ID` resolve to (`DOM_EMAIL`, default this value) |
| Dom's object id | `19fb2afd-6814-4600-8697-eb798ec5691f` | `az ad signed-in-user show --query id -o tsv`. Already in `infra/params/dev.bicepparam` as the Postgres Entra administrator. |
| App role `Lance.User` id | `b98fd184-521c-4ebe-9889-bb9d03c8322c` | Generated once, in `scripts/entra/setup-app-roles.sh` and `packages/shared/src/roles.ts` |
| App role `Lance.Admin` id | `3f59d957-584d-4fc7-9233-45d4979d06f8` | As above |
| Group `Lance Users` object id | Printed by section 8; record it here after the run | `az ad group list --filter "displayName eq 'Lance Users'" --query "[0].id" -o tsv` |
| Group `Lance Admins` object id | Printed by section 8; record it here after the run | `az ad group list --filter "displayName eq 'Lance Admins'" --query "[0].id" -o tsv` |
| Microsoft Graph service principal | `33c5497c-a4e7-4249-ac4f-23ce45cd3f09` | `az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv` |

The client id, tenant id, UPNs, object ids and role ids are identifiers, not secrets, and may live in docs and parameter files. The client secret is the only secret this runbook produces.

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
```

Keep the secret out of shell history: `read -s SECRET` first, then pass `--value "$SECRET"`.

There is no `allowed-upn` secret any more: who may sign in is decided by the app roles in section 8. A vault that already holds one keeps it; no app binds it, and the template never deletes a secret.

## 6. Postgres Entra administrator

Nothing to do by hand. The Azure Database for PostgreSQL Flexible Server is the managed Postgres that Bicep creates (`infra/modules/postgres.bicep`), and the template sets Dom as its Entra administrator from `postgresEntraAdminObjectId` and `postgresEntraAdminPrincipalName` in the parameter file. Password authentication is off; Dom signs in to Postgres with an Entra token, which `deploy.md` step 7 shows.

## 7. First delegated consent

The connect route is behind Entra bearer authentication, so it is started from the web app's Settings page: sign in, open Settings and press Connect Microsoft 365. The button goes to the web app's own `/api/graph/connect`, which calls the api with the session's token and forwards the browser to Microsoft; typing the api URL into a browser does not work. Consent once as Dom. The api exchanges the code, stores the refresh token in Key Vault as `graph-refresh-token`, records a `state_changed` ledger event with `change: graph_connected`, and every later refresh rotates the stored token. `/lance status` then shows the Graph connector as connected.

## 8. App roles, groups and assignment required

ADR 0020: access to Lance is granted by the Entra app roles `Lance.User` and `Lance.Admin`, assigned to the security groups `Lance Users` and `Lance Admins`, and the enterprise application requires assignment, so nobody outside the groups gets a token. `ALLOWED_UPN` is retired.

**What must exist first.** The app registration and its service principal (section 1), and the environment's Key Vault holding `entra-client-id` (created by `infra/main.bicep` through `deploy.md` steps 1 to 4, filled in section 5). The person running the script signs in to `az` as an Entra administrator who may create groups, edit the app registration and assign app roles; the script adds that person to both groups, so for dev it is Dom.

**Run it before deploying the build that carries ADR 0020.** The old build admits by UPN and ignores roles, so the script changes nothing Dom sees. The new build refuses a token without a Lance role, so deployed first it would keep Dom out of the web app until the script had run (the script needs only `az`, so that is recoverable, not a lock-out). Then deploy (`deploy.md`), then sign in once to bind Dom's object id.

**Run it.**

```
scripts/entra/setup-app-roles.sh dev
```

It reads every identifier itself (tenant from `az account show`, vault from `rg-lance-<env>`, client id from the vault, service principal, the signed-in administrator, Graph's service principal), echoes each one as `NAME=value`, and does the following, each step skipped when already done, so a rerun is safe:

| Step | Changes in the tenant |
|---|---|
| 1 | Renames the app registration and the enterprise application to `Lance (Valliance)` |
| 2 | Adds the app roles `Lance.User` (`b98fd184-...`) and `Lance.Admin` (`3f59d957-...`); any other role is left as it is |
| 3 | Creates the security groups `Lance Users` and `Lance Admins` if absent |
| 4 | Adds the signed-in administrator to both groups |
| 5 | Assigns `Lance Users` the `Lance.User` role and `Lance Admins` the `Lance.Admin` role on the enterprise application |
| 6 | Requests two Microsoft Graph application permissions on the app registration, without consenting to them: `Application.Read.All` and `GroupMember.ReadBasic.All` |
| 7 | Sets "Assignment required" on the enterprise application, last, once the administrator already holds both roles |

It ends by printing the known-values table (record the two group ids in the table at the top of this runbook) and the two admin-consent commands.

**Admin consent for the nightly role check.** The worker's role check (`apps/worker/src/roles/roleCheck.ts`) reads `GET /servicePrincipals(appId=...)/appRoleAssignedTo` and `GET /groups/{id}/transitiveMembers` with the app's own client credentials. The least-privileged application permissions for those two reads, as the Graph reference lists them, are `Application.Read.All` (the alternatives are write permissions or `Directory.Read.All`) and `GroupMember.ReadBasic.All` (member ids without their profiles, which is all the check needs). Roles are assigned to groups, so the assignment list alone names groups, not people; the second permission is what turns a group into its members. Consent is not granted by the script. Read what each permission grants, then run the two `az rest ... /appRoleAssignments` commands the script prints; each grants one permission to Lance's own service principal. `az ad app permission admin-consent` would do the same, but it also re-consents every delegated scope the app requests, so the targeted commands are preferred.

**Check it.**

```
az ad sp show --id <client id> --query "{name:displayName, required:appRoleAssignmentRequired}" -o json
az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/<sp id>/appRoleAssignedTo" --query "value[].{who:principalDisplayName, type:principalType, role:appRoleId}" -o table
```

Then sign out of the web app and in again: the id token now carries `roles`, the api binds Dom's Entra object id to his principal on that first request (a `state_changed` event with `change: principal_bound`), and every page loads as before. Someone outside both groups is stopped by Microsoft before they reach Lance; someone added to `Lance Users` arrives as an `onboarding` principal who sees only the onboarding placeholder.

**Undo.** To stop requiring assignment: `az ad sp update --id <sp id> --set appRoleAssignmentRequired=false`. Nothing else the script created needs removing for Lance to keep working.
