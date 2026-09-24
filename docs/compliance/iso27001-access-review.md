# Lance in the ISO 27001 access review

For Valliance's ISO 27001 owner and auditor. Lance is listed in the periodic access review as one system.

## The evidence: two Entra groups

Access to Lance is granted only through Microsoft Entra ID (ADR 0020). The enterprise application `Lance (Valliance)` requires assignment, so nobody outside these two groups can sign in:

| Group | Grants | Who should be in it |
|---|---|---|
| `Lance Users` | The app role `Lance.User`: use Lance for your own mail, meetings and tasks | Colleagues who have chosen to use Lance |
| `Lance Admins` | The app role `Lance.Admin`: the admin page (health, never content), organisation rules, offboarding and the evidence export | Dom Selvon, and anyone the ISO owner approves |

The group memberships are the access list. No list is kept inside Lance.

## Listing the members

With the Azure CLI, signed in to the Valliance tenant (`az login`) as anyone who may read groups:

```
az ad group member list --group "Lance Users" --query "[].{name:displayName, upn:userPrincipalName}" -o table
az ad group member list --group "Lance Admins" --query "[].{name:displayName, upn:userPrincipalName}" -o table
```

To confirm the application still requires assignment, and which groups hold its roles:

```
SP=$(az ad sp list --display-name "Lance (Valliance)" --query "[0].id" -o tsv)
echo "$SP"
az ad sp show --id "$SP" --query appRoleAssignmentRequired -o tsv
az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP/appRoleAssignedTo" \
  --query "value[].{group:principalDisplayName, type:principalType}" -o table
```

The first prints `true`. The second lists `Lance Users` and `Lance Admins` as groups and nothing else.

## What happens when someone is removed

Removal from both groups stops the person's next sign-in. The nightly role check (02:30 UK time) also pauses them in Lance the first night, raising an alert to the admins, and offboards them seven days later if they are still in neither group: their credentials are deleted and their private Slack channel archived ([offboard-principal.md](../runbooks/offboard-principal.md)). Every step is recorded in Lance's ledger.

## Evidence export

A Lance admin can export a signed bundle for any period up to a year from the admin page (Evidence export). Without a principal chosen it holds system events only: sign-ups, role changes, Slack links, pauses, offboarding steps, organisation rule changes and retention runs. With a principal chosen it adds the metadata of every ledger entry for that principal (when, what kind, which system, a fingerprint of the content) and never the content.

The bundle is signed with an Ed25519 key held in Lance's Key Vault (`evidence-signing-key`). Each bundle names its key by a short id (`signature.keyId`). Record the key id here when the key is created or rotated (`deploy.md` step 4 prints it):

| Environment | Key id | Created |
|---|---|---|
| dev | *to be recorded when the key is set* | |
| prod | *to be recorded when the key is set* | |

To check a bundle, with OpenSSL 3 (on a Mac, `/opt/homebrew/bin/openssl`; the built-in `openssl` cannot) and `jq`:

```
OPENSSL=/opt/homebrew/bin/openssl
jq -j .signed bundle.json > signed.json
jq -j .signature.value bundle.json | base64 -d > signature.bin
jq -r .signature.publicKey bundle.json > public.pem
$OPENSSL pkeyutl -verify -pubin -inkey public.pem -rawin -in signed.json -sigfile signature.bin
$OPENSSL pkey -pubin -in public.pem -outform DER | $OPENSSL dgst -sha256 | awk '{print substr($NF, 1, 16)}'
```

The first command prints `Signature Verified Successfully`; the second prints the key id, which must match the one recorded above. `signed.json` is the bundle's content, readable with `jq . signed.json`.
