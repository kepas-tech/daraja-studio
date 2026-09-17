# Operators: states, the two-try guard, and credential errors — design (feature 8)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md`, section B (Operators page) and
section D (initiator failover + `darajaFailureClass`), priority item 8; the order brief. Date
2026-09-16, version 0.23.0.

## What the owner gets

The operator cards already in Settings › Daraja app say, in the owner's words, whether the operator
is working: **Active**, **Standby**, or **DOWN**, when its password expires, how many times it has
just failed, and a **Reinstate** button to try it again. And when Safaricom refuses a payment with
2001, 8006 or TP40153, the three-line error says the operator credential is the problem — not the
payment, and not the customer.

Studio keeps its own shape: one operator per environment by default, a second optional, no wallet
and no per-app pool. KEPAS Pay's ordered failover pool and its "New password → Check & switch"
wizard are not copied; Studio already probes and rotates one operator at a time.

## Where the operators live today (the code's facts, which win over the plan's words)

The plan says "Operators page under Organisation". In this code the cards are a section of
**Settings › Daraja app** (`web/src/pages/settings/EnvironmentTab.tsx`), with routes under
`/api/settings/environments/:env/operators`. This feature keeps them there and improves them; a
second page showing the same rows would be one place too many. Say so in the report.

## The two-try guard

Today one credential-class failure marks the operator `failed` immediately
(`money_out/operatorHealth.ts`). One failure is often a stale password that the next call with a
fresh token survives, so: **an operator goes DOWN on the second credential-class failure inside 10
minutes, not the first.**

Migration `027_operator_failures.sql` adds to `operators`:

```sql
consecutive_failures int NOT NULL DEFAULT 0,
last_failure_at timestamptz,
down_since timestamptz
```

Rules, in `failOperatorOnCredentialCode`:

- Not a credential code, no operator, or the operator is already `disabled` → nothing changes.
- A credential-class failure: if `last_failure_at` is older than 10 minutes, the count starts
  again at 1; otherwise it goes up by one. `last_error` is always refreshed, and
  `operator.updated` is published with the count so the page can show "1 of 2".
- Count reaches 2 → `status='failed'`, `down_since=now()`, and one `operator.updated` with
  `status:'failed'`.
- Any success clears it: a probe that Safaricom accepts, or a request of this operator that reaches
  `completed`, sets `consecutive_failures=0`, `last_failure_at=null`, `down_since=null`. One
  helper, `clearOperatorFailures(db, operatorId)`, called from the probe path and from the callback
  apply path when a row settles.

`status` keeps its four values; the page maps them to the owner's words:

| status | the card says | what it means |
|---|---|---|
| `verified` | Active | Safaricom accepted it; sends go through it |
| `pending` | Standby | being checked, or waiting for Safaricom's answer |
| `failed` | DOWN | two credential failures; sends do not use it |
| `disabled` | Switched off | the owner turned it off |

## Credential-class errors

- `CREDENTIAL_CODES` gains `TP40153` beside `2001` and `8006`.
- `server/src/sdk/meaning.ts` gains the three-line meaning for `TP40153` on the scopes that can
  see it (b2c, b2b, balance, reversal), worded as the operator's problem: what Safaricom said, that
  the **operator credential** is what failed (not the payment, not the customer's money), and what
  to do — Settings › Daraja app, give the operator a new password, then Reinstate.
- The existing 2001 and 8006 lines gain the same closing step: "then press Reinstate on the operator
  card", so every credential error ends in the same place.

## API

| Method | Path | Gate | Answer |
|---|---|---|---|
| GET | `/api/settings/environments/:env/operators` | as today | unchanged shape, plus `consecutiveFailures`, `lastFailureAt`, `downSince` |
| POST | `/api/settings/operators/:id/probe` | as today (no step-up) | 204; "Reinstate" is this call |

No new route, no new permission: Reinstate is the existing probe, and the card now offers it on a
failed operator too. Nothing here moves money.

## Web

- The operator card shows: the name, the state word, "N of 2 failures" while one failure stands,
  "expires in N days" (or "expired N days ago"), the last error line when it is DOWN, and the
  buttons it already has (new password, switch off) plus **Reinstate** on a failed operator.
- Copy in `web/src/copy/en.ts` under `settings.operator*`; guide task updated in place; the guard
  passes.

## Tests

Server (`server/test/operator-failures.test.ts`):
1. One credential failure leaves the operator `verified`, with the count at 1 and the error kept.
2. A second inside the window marks it `failed`, sets `down_since`, and publishes one event.
3. A second failure outside the window starts the count again at 1 and does not go DOWN.
4. A non-credential code (for example 1032) leaves the count alone.
5. A probe Safaricom accepts clears the count, `last_failure_at` and `down_since`.
6. A settled request of that operator clears them too.
7. `TP40153` is a credential code and its three-line meaning names the operator, not the payment.
8. A disabled operator is never touched by any of this.

Web (`web/src/test/operator-states.test.tsx`): the card words for each of the four statuses, the
"1 of 2" line, "expires in N days", and Reinstate posting to the probe route.

## Out of scope

- An ordered multi-operator failover pool: Studio keeps one operator per environment, with a second
  optional. The plan says the same.
- WebAuthn or PIN for the operator password: KEPAS Pay's admin login, not its operators.
