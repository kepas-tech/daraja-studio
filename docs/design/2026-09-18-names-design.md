# Names, everywhere — design (round 3, phase A)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md`, phase A. Date 2026-09-18, version
0.38.0. The owner's complaint: "we don't see anyone's names at all."

## The idea in one line

Studio already receives more names than it shows: Safaricom sends `FirstName`, `MiddleName`,
`LastName` on a paybill payment, `ReceiverPartyPublicName` on a B2C result, and
`DebitPartyName`/`CreditPartyName` on a status result. Fix where each one is dropped, keep the
raw value in the payload, and let the read layer say once and for all whose name
`requests.recipient_name` holds.

## One helper, at the point of storage

`server/src/util/names.ts`:

```ts
personName(raw)                    // one Safaricom name string -> a person's name, or null
joinPersonName(first, middle, last) // the three-part form -> the same
```

`personName` rules, in order:

1. `"254712345678 - JANE DOE"` → `"JANE DOE"`: Safaricom's party names are `phone - NAME`. Split
   on the first `" - "` and keep the name; the number is already on the row.
2. Inner runs of whitespace collapse to one space; the ends are trimmed.
3. A value with no letter in it is not a name (a bare phone number, say) → null.
4. `MPESA` alone is the Pull API's placeholder payer name, not a person → null. KEPAS Pay reads it
   the same way twice (`services/notificationClassifier.js:87`, `src/views/admin/c2b/index.ejs:98`,
   "the Pull API's placeholder payer name"), and the live studio's own six pulled rows are named
   exactly that.
5. Empty, whitespace, or null → null.

It runs at storage — the B2C result, the C2B confirmation and validation, the pull backfill, the
status result, the invoice push — and again in the read layer, so rows written before this phase
read the same way new ones are stored. Nothing is lost: the raw value stays in `raw_result_json`
(the whole callback body) or in `payload_json` (the C2B insert now keeps the three name fields).

## The read layer names it by direction

`requests.recipient_name` is one column holding four different people: a paybill payer, a payout
payee, an invoice payer and a status result's credit party. `RequestView` gains:

```ts
direction: 'in' | 'out' | null   // null on a row that moves no money (a status query, a balance check)
party: {
  name: string | null            // the person: Safaricom's name, else the account's, else the contact's
  number: string | null          // what to show under it; null when Safaricom sent only its hashed token
  savedName: string | null       // the owner's own label for that number, shown beside the name when
                                 // the two differ, because a mismatch is what a person needs to see
}
```

The direction comes from `INCOMING_TYPES` (`server/src/money_out/registry.ts`): the collect kinds
plus the two that arrive unasked (c2b, invoice_payment). Everything else that moves money is out.
Screens stop asking what type a row is and read `party`; the words "From", "To" and "Name" stay in
`web/src/copy/en.ts`.

History's direction filter goes the same way: the page sends `direction=in` or `direction=out` and the
server answers with its own lists (`money_out/routes.ts`, `typeFilter`). The page used to keep its
own copy — `{ in: 'c2b,stk', out: 'b2c,reversal' }` — which had already drifted: express, Bonga,
Ratiba and invoice payments were missing from "money in".

## The eleven faults, and where each one is fixed

| # | Fault | Fix |
|---|---|---|
| 1 | The pull backfill hardcodes `middleName: ''`, `lastName: ''` | `money_in/service.ts` reads all three, and the named parts win over the portal's `sender` column |
| 2 | `"254… - NAME"` stored and shown raw | `personName` at every point of storage, and in the read layer for old rows |
| 3 | The name is the grey line, the phone the headline | `PartyLine` (web): the name leads, the number sits under; History, Home, RequestCard, Waiting |
| 4 | A saved contact hides Safaricom's name | both are shown when they differ, "Saved as X" under the name |
| 5 | A payout has no name until it completes | the insert writes the best name known: contact, then account, then the confirmed name check (a bulk row's own name column stands in for the last of those) |
| 6 | The confirmed name check is thrown away | the review screen sends it, the send stores it |
| 7 | Invoice payments store no payer | the push's own name when it carries one, else the account's name |
| 8 | A payer is labelled "To" | the row's direction decides the word: money in says "From" |
| 9 | Money in shows only paybill payments | `money_in/routes.ts` lists every money-in kind |
| 10 | `DebitPartyName` is never read | read, and chosen by the row's direction: money in takes the payer, money out the payee |
| 11 | The validation callback drops the name | kept in the cache for half an hour, keyed by the receipt, and used when the confirmation arrives without one |

## The saved name that belongs to a number, not to a row

A payment that arrives without a request of ours never named a contact, so a paybill payment had no
saved name even when the payer's number was already in the address book — and the Pull API's `MPESA`
placeholder is not a name either. The read layer therefore matches a row to the phone contact that
holds its number (a lateral join in `VIEW_SELECT`), the same way a send links the contact it was made
with. The owner's own label for that number becomes the row's saved name, and a contact retired on
purpose is not matched: the row keeps whatever its own link already holds. This works on the rows
already written, so no database row is rewritten.

## What this phase does not change

- No migration: the column stays, and `recipient_name` is not in migration 004's final-row guard, so
  a name recovered by a lookup may still be written onto a settled row.
- No new table, no rewrite of existing rows. A row written before this phase is read through the same
  helper, so a stored `"254… - NAME"` shows as the name without anyone touching the database.
- Money, statuses, receipts and amounts are untouched. Phase A writes names and nothing else.
