# Runbook: Entra app registration for Lance

Manual, once per environment. Fifteen minutes. Read the "Order of operations" first; it is the part that trips people up.

## Order of operations

Three things reference each other:

- The Entra app registration (this runbook) produces a client id, a tenant id and a client secret.
- The two Key Vaults (the static vault `kv-lance-<env>-<suffix>` and the principal vault `kv-lance-p-<env>-<suffix>`, ADR 0022), the Postgres Flexible Server and the Container Apps are created by the Bicep deployment in `deploy.md` (`infra/main.bicep`). They do not exist until that has run. The template creates `entra-tenant-id`, `entra-client-id` and `entra-client-secret` in the static vault as placeholders; section 5 replaces them.
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
| Service principal (enterprise application) object id | `6a1e3a1b-e37e-44fc-aa47-a30fa68f2c80` | `az ad sp show --id d72a4e64-a707-4387-b7e3-fdfd3e75a64b --query id -o tsv` |
| Entra ID P1 | None in the tenant, checked 2026-09-25, so roles are assigned to users, not groups (ADR 0020 amendment) | `az rest --method GET --uri https://graph.microsoft.com/v1.0/subscribedSkus --query "value[].servicePlans[?contains(servicePlanName,'AAD_PREMIUM')].servicePlanName"` prints only empty lists |
| Microsoft Graph service principal | `33c5497c-a4e7-4249-ac4f-23ce45cd3f09` | `az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv` |
| Static Key Vault | `kv-lance-dev-j7riq4` | `az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-dev-')].name" -o tsv` |
| Principal vault | `kv-lance-p-dev-j7riq4` | `az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-dev-')].name" -o tsv`; exists after the first deploy that carries ADR 0022 |

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

After `deploy.md` step 3 has created the static vault (its name is printed by the deployment, `kv-lance-<env>-<suffix>`). The three secrets exist already as placeholders; these commands write the real values over them, and no later deploy writes them again:

```
KV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-dev-')].name" -o tsv)
echo "$KV"
az keyvault secret set --vault-name $KV --name entra-tenant-id --value ac995b50-b931-4d4b-b0ea-c0617e8141f9
az keyvault secret set --vault-name $KV --name entra-client-id --value d72a4e64-a707-4387-b7e3-fdfd3e75a64b
az keyvault secret set --vault-name $KV --name entra-client-secret --value '<the secret from step 4>'
```

Keep the secret out of shell history: `read -s SECRET` first, then pass `--value "$SECRET"`.

There is no `allowed-upn` secret any more: who may sign in is decided by the app roles in section 8. A vault that already holds one keeps it; no app binds it, and the template never deletes a secret.

## 6. Postgres Entra administrator

Nothing to do by hand. The Azure Database for PostgreSQL Flexible Server is the managed Postgres that Bicep creates (`infra/modules/postgres.bicep`), and the template sets Dom as its Entra administrator from `postgresEntraAdminObjectId` and `postgresEntraAdminPrincipalName` in the parameter file. Password authentication is off; Dom signs in to Postgres with an Entra token, which `deploy.md` step 7 shows.

## 7. Delegated consent, per principal

Each principal connects their own Microsoft 365 (ADR 0022). The connect route is behind Entra bearer authentication, so it is started from the web app's Settings page: sign in, open Settings and press Connect Microsoft 365. The button goes to the web app's own `/api/graph/connect`, which calls the api with the session's token and forwards the browser to Microsoft; typing the api URL into a browser does not work. An active principal, or one still onboarding (multi-user M3 step 2), may connect; a paused or offboarded one is refused.

The api exchanges the code and stores the refresh token in the principal vault as `graph-refresh-token--<principalId>`, for the principal who started the consent and nobody else. It holds only the custom role `Lance principal secret writer` there, so it can write the secret and never read it back. It records a `state_changed` ledger event with `change: graph_connected`. The worker reads the secret, and every refresh rotates it under a Postgres advisory lock for that principal. `/lance status` then shows the Graph connector as connected.

Dom's token from before ADR 0022 is in the static vault as `graph-refresh-token`. The worker copies it once into his own secret, so Dom does not need to consent again (`deploy.md`, last section).

## 8. App roles, assignment and who has access

ADR 0020 and its amendment: access to Lance is granted by the Entra app roles `Lance.User` and `Lance.Admin`, assigned to people directly on the enterprise application, and the enterprise application requires assignment, so nobody without a Lance role gets a token. Groups are not used: assigning a group to an app role needs Entra ID P1, which the tenant does not have (known values above). `ALLOWED_UPN` is retired.

**What must exist first.** The app registration and its service principal (section 1), and the environment's static Key Vault `kv-lance-<env>-<suffix>` holding `entra-client-id` (created by `infra/main.bicep` through `deploy.md` steps 1 to 4, filled in section 5). The person running the script signs in to `az` as an Entra administrator who may edit the app registration and assign app roles; the script gives that person both roles, so for dev it is Dom.

**Run it before merging the build that carries ADR 0020.** The old build admits by UPN and ignores roles, so the script changes nothing Dom sees. The new build refuses a token without a Lance role, so deployed first it would keep Dom out of the web app until the script had run (recoverable, since the script needs only `az`). The full upgrade order is at the top of `deploy.md`.

**Run it.**

```
scripts/entra/setup-app-roles.sh dev
```

It reads every identifier itself (tenant from `az account show`, the static vault from `rg-lance-<env>` by its `kv-lance-<env>-` prefix, client id from the vault, service principal, the signed-in administrator, Graph's service principal), echoes each one as `NAME=value`, and does the following, each step skipped when already done, so a rerun is safe:

| Step | Changes in the tenant |
|---|---|
| 1 | Renames the app registration and the enterprise application from `Lance (Dom)` to `Lance (Valliance)` |
| 2 | Adds the app roles `Lance.User` (`b98fd184-...`) and `Lance.Admin` (`3f59d957-...`); any other role is left as it is |
| 3 | Assigns both roles to the signed-in administrator on the enterprise application |
| 4 | Requests one Microsoft Graph application permission on the app registration, without consenting to it: `Application.Read.All` |
| 5 | Sets "Assignment required" on the enterprise application, last, once the administrator already holds both roles |

It ends by printing the known-values table and the admin-consent command.

**The existing default assignment.** On 2026-09-25 the enterprise application's only assignment is a default-access one for the account "365 Admin - Dom Selvon". After step 5 that account can still get a token but holds no Lance role, so Lance refuses it. That is intended unless Dom uses that account for Lance.

**Admin consent for the nightly role check.** The worker's role check (`apps/worker/src/roles/roleCheck.ts`) reads `GET /servicePrincipals/{id}/appRoleAssignedTo` with the app's own client credentials. The least-privileged application permission for that read, as the Graph reference lists it, is `Application.Read.All` (the alternatives are write permissions or `Directory.Read.All`). Roles are assigned to users, so the assignment list names the people directly. Consent is not granted by the script: read what the permission grants, then run the `az rest ... /appRoleAssignments` command the script prints, which grants that one permission to Lance's own service principal. Until consent, the role check logs that it lacks the permission and pauses nobody.

**Giving or removing access.**

```
scripts/entra/grant-access.sh dev colleague@valliance.ai user          # Lance.User
scripts/entra/grant-access.sh dev colleague@valliance.ai admin         # Lance.User and Lance.Admin
scripts/entra/grant-access.sh dev colleague@valliance.ai admin --remove  # Lance.Admin only
scripts/entra/grant-access.sh dev colleague@valliance.ai user --remove   # both roles
```

A person given `Lance.User` arrives at their first sign-in as an `onboarding` principal. Removing both roles stops their next sign-in; the nightly role check pauses their principal and, seven days later, offboards it (`docs/runbooks/offboard-principal.md`).

**Check it.**

```
az ad sp show --id <client id> --query "{name:displayName, required:appRoleAssignmentRequired}" -o json
az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/<sp id>/appRoleAssignedTo" --query "value[].{who:principalDisplayName, type:principalType, role:appRoleId}" -o table
```

Then sign out of the web app and in again: the id token now carries `roles`, the api binds Dom's Entra object id to his principal on that first request (a `state_changed` event with `change: principal_bound`), and every page loads as before.

**Undo.** To stop requiring assignment: `az ad sp update --id <sp id> --set appRoleAssignmentRequired=false`. Nothing else the script created needs removing for Lance to keep working.
