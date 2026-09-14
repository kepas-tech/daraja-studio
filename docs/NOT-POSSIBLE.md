# Not possible via API

Safaricom keeps these in its portal. This list mirrors the "Not possible via API" page in
daraja-studio (`web/src/copy/en.ts` → `notPossible`, rendered by `web/src/pages/NotPossible.tsx`).
The page is the source of truth — keep this file in sync with it.

## Withdraw to the bank
- **What**: Move money from M-Pesa to your bank account (normal or real-time).
- **Why not here**: Safaricom offers no API for organization withdrawals. Only the portal and USSD can start one.
- **Where**: Transaction › Initiate Transaction › Organization Withdrawal From M-PESA
- **Phone**: `*234*4#`

## Move float from Utility to Working
- **What**: Sweep collections from the Utility account into the Working (MMF) account.
- **Why not here**: The API command for this direction always fails with ResultCode 21. Safaricom API support confirmed it is manual only.
- **Where**: Transaction › Initiate Transaction › Pay Bill Services – MMF Account Transfer
- **Phone**: `*234#` (full sweep)

## Create operators and give them roles
- **What**: Add a person or API user in the Safaricom portal, set their access channel and roles.
- **Why not here**: Operator management has no API. Studio permissions sit on top of Safaricom roles; both must exist.
- **Where**: Search › Organization Operator › Create, or › Detail › Role › Edit

## Reset an operator's portal password
- **What**: Send a new password to a portal operator.
- **Why not here**: No API. Studio can only take a new API password after you set it in the portal.
- **Where**: Search › Organization Operator › Detail › Reset Password

## Organization profile and KYC
- **What**: Contacts, nominated number, notification phone, Double Hakikisha, Reversal Initiation.
- **Why not here**: KYC data is portal-only. Studio keeps a read-only copy you type in once.
- **Where**: Search › Organization › Details › KYC Info › Edit

## Bank accounts
- **What**: Add, edit or remove the bank account linked to the shortcode.
- **Why not here**: No API.
- **Where**: Search › My Organization › Bank Account

## Tills
- **What**: Create or close a till under the organization.
- **Why not here**: No API.
- **Where**: Search › My Organization › Till

## Revenue settlement plans
- **What**: Schedule settlements to the bank.
- **Why not here**: No API.
- **Where**: Business Center › Revenue Settlement

## Tax exemption, accounting model, state tags
- **What**: Organization-level tax and hierarchy settings.
- **Why not here**: No API.
- **Where**: Search › Organization › Details

## Close the organization
- **What**: Permanently close the shortcode.
- **Why not here**: No API, by design.
- **Where**: Search › Organization › Close

## Safaricom's own account statement
- **What**: The official statement with running balance per account.
- **Why not here**: No statement API. Studio History is its own ledger built from callbacks and pulls, not Safaricom's statement.
- **Where**: Transaction › Account Statement › Export

## Bulk operator creation
- **What**: Upload a CSV of operators.
- **Why not here**: No API.
- **Where**: Business Center › Bulk Task › Create Organization Operator

## Operator Creation Approval Switch
- **What**: Portal's own maker-checker for creating operators.
- **Why not here**: Portal setting only.
- **Where**: Search › Organization › Details › KYC Info

## Change registered paybill callback URLs
- **What**: Point paybill payments at a different system after the first registration in production.
- **Why not here**: Production Daraja refuses to overwrite registered URLs. Delete and re-add them in the Daraja portal.
- **Where**: developer.safaricom.co.ke › My Apps › your app › C2B URLs

## Audit log of portal actions
- **What**: What people did inside the Safaricom portal.
- **Why not here**: No API. Studio audits only what happens in studio.
- **Where**: My Preference › Audit Log
