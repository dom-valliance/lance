# Runbook: Entra app registration for Lance

Manual, once per environment. Takes about fifteen minutes. Outputs go into Key Vault, never into the repo.

## 1. Register the application

1. Entra admin centre, App registrations, New registration.
2. Name: `Lance (Valliance)`. Supported account types: single tenant. Leave the redirect URI empty for now.
3. Record the Application (client) id and Directory (tenant) id.

## 2. Redirect URIs

Platform: Web. Add:

- `https://<web-hostname>/api/auth/callback/microsoft-entra-id` for sign-in to the web UI.
- `https://<api-hostname>/auth/graph/callback` for the delegated Graph consent flow the worker uses.
- `http://localhost:3000/api/auth/callback/microsoft-entra-id` and `http://localhost:3001/auth/graph/callback` for local development.

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

Do not add `Mail.Send`. Its absence is the second lock behind the policy hard floor on sending email. Grant admin consent for the tenant so Dom's first sign-in does not prompt.

## 4. Client secret

Certificates and secrets, New client secret, description `lance-<env>`, expiry 12 months. Copy the value once. Store it in Key Vault as `entra-client-secret`. Add a calendar reminder for rotation at 11 months and follow `rotate-secrets.md`.

## 5. Key Vault entries

| Secret name | Value |
|---|---|
| `entra-tenant-id` | Directory (tenant) id |
| `entra-client-id` | Application (client) id |
| `entra-client-secret` | Secret value from step 4 |
| `allowed-upn` | Dom's UPN |

## 6. Postgres Entra administrator

On the Flexible Server, Authentication, add the deployment identity as an Entra administrator so migrations can create the managed identity principals described in ADR 0008.

## 7. First delegated consent

After the `api` app is deployed, open `https://<api-hostname>/auth/graph/connect` as Dom. Consent once. The api stores the refresh token in Key Vault as `graph-refresh-token` and records a `state_changed` ledger event. `/lance status` shows the Graph connector as connected.
