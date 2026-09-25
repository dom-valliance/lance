# 0020. Access is granted by Entra app roles

Date: 2026-09-24
Status: Accepted

## Context

Spec section 12 allows one UPN, read from `ALLOWED_UPN` by the web app and the api. The multi-user plan (`docs/plans/multi-user.md`, M1) opens Lance to the members of a group. At 2026-09-24 the app registration `Lance (Dom)` (client id `d72a4e64-a707-4387-b7e3-fdfd3e75a64b`, service principal `6a1e3a1b-e37e-44fc-aa47-a30fa68f2c80`) has no app roles and does not require assignment, and no Lance groups exist.

## Decision

The app registration is renamed `Lance (Valliance)`, as `CLAUDE.md` names it, and gains two app roles, `Lance.User` and `Lance.Admin`, assigned to two security groups, `Lance Users` and `Lance Admins`. The enterprise application requires assignment, so nobody outside the groups gets a token for it. The `roles` claim in the id token and the api's bearer token decides sign-in (`Lance.User` or `Lance.Admin`) and admin procedures (`Lance.Admin`). App roles avoid the groups-claim overage that affects people in many groups, and keep the access list in Entra, where the ISO 27001 access review already looks. The principal is resolved per request from the token's `oid` through `principals.entra_oid`; a first sign-in with a role creates a principal with status `onboarding`. `ALLOWED_UPN` is retired. A nightly job reads the role assignments through Graph and pauses, with a P1 alert to admins, any principal who has lost their role.

## Consequences

Granting or removing access is a group change in Entra, recorded where access reviews already look. Every Entra change in this ADR is made by a script under `scripts/entra/`, run once by Dom, and every identifier it produces goes into the runbook's known-values table. Requiring assignment before Dom holds a role would lock him out, so the script assigns the groups first and switches assignment on last.

## Amendment, 2026-09-25: roles are assigned to users

Assigning a group to an app role needs Entra ID P1. The Valliance tenant has none: `GET /subscribedSkus` on 2026-09-25 lists no service plan with `AAD_PREMIUM` (its Microsoft 365 plan is Business Standard, `O365_BUSINESS_PREMIUM`). So `Lance.User` and `Lance.Admin` are assigned to users directly on the enterprise application, which the free tier allows, and the groups `Lance Users` and `Lance Admins` are not created. The access list is still held in Entra: it is the enterprise application's list of users and their roles, which `scripts/entra/grant-access.sh` changes and the ISO 27001 access review reads. The nightly role check reads the same list and needs only `Application.Read.All`. If the tenant gains P1, assigning the two groups instead is a change to the script and nothing else.
