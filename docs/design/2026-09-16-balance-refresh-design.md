# Balance after every settled request, and the Home line — design (feature 9)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md` section C (balance snapshots, float
coverage) and priority item 9; the order brief. Date 2026-09-16, version 0.24.0.

## What the owner gets

The balance on Home is no longer a day old: every time a payment finishes, Studio asks Safaricom
for the balance again — quietly, at most once a minute — so the number the owner reads is the
number after the last thing that happened. And beside it, one line: **"Balance KES X · waiting to
go out KES Y"**, in a warning tone when more is on its way out than there is to send.

## The debounced refresh

KEPAS Pay refreshes after every money event and debounces it; Studio does the same, in the one
place a request reaches a final status.

`server/src/callbacks/apply.ts` ends every settled row. When the status it writes is final
(`completed` or `failed`), it calls `scheduleBalanceRefresh(db)`:

```ts
/** One balance query per organisation, no sooner than a minute after the last thing that settled. */
export async function scheduleBalanceRefresh(db: Db): Promise<void> {
  const pending = await db.query(
    `SELECT 1 FROM jobs WHERE kind='balance_refresh' AND done_at IS NULL AND run_at > now() LIMIT 1`);
  if (pending.length > 0) return;                    // a refresh is already coming
  await enqueue(db, 'balance_refresh', { reason: 'settled' }, { runAt: new Date(Date.now() + 60_000), maxAttempts: 2 });
}
```

- One pending job, not one per payment: a busy minute costs one balance query, not fifty. The check
  and the insert are one statement (`INSERT ... WHERE NOT EXISTS`) so two callbacks landing together
  cannot both enqueue.
- The job runs in the organisation that enqueued it (the existing one-shot job rule) and calls the
  existing `moneyOut.refreshBalance(null)` — the same path the daily job and the Refresh button use,
  so there is one balance query, one `balances` row, one `balance.updated` event. Nothing new talks
  to Safaricom.
- A refresh that Safaricom refuses is logged and dropped exactly as the daily job already does: a
  credential problem is the operator card's business, not a storm of retries.
- The daily refresh stays. This is in addition, not instead.

## Waiting to go out

`waitingCents` = the sum of `amount_cents` over money-out rows that have not finished:
`type` in `MONEY_TYPES` and `status` in (`pending`, `sent`, `awaiting_approval`). A failed row is
not waiting; a completed one has already gone.

`GET /api/balances/latest` gains `waitingCents: number` beside the three balances it already
returns, so Home keeps making one call. No new route, no new permission.

## Web

- `web/src/components/BalanceHero.tsx` (Home): under the balance, one line —
  "Balance KES 12,300 · waiting to go out KES 4,000" — where "Balance" is the **Utility** balance,
  the account sends come from. When `waitingCents > utilityCents`, the line takes the warning tone
  and adds one sentence: "Move float from Working before the next send." (The float move itself is a
  planned send type, so the sentence points at the Safaricom portal for now, as the send review
  already does.)
- When there is no balance yet, the line says so instead of showing a zero: a zero would be a lie.
- Copy in `web/src/copy/en.ts` under `home.balanceLine`; guide step updated; guard passes.

## Tests

Server (`server/test/balance-refresh.test.ts`):
1. A settled request (`completed`) enqueues exactly one `balance_refresh` job, due about a minute
   out.
2. A second settled request while that job is pending enqueues nothing.
3. A `failed` row also counts as settled; a `sent` row does not.
4. The job handler calls the balance path once and writes one `balances` row.
5. `GET /api/balances/latest` carries `waitingCents` summed over pending, sent and awaiting_approval
   money-out rows, and not over failed or completed ones.
6. Two callbacks landing together still leave one pending job.

Web (`web/src/test/balance-line.test.tsx`): the line renders balance and waiting; waiting greater
than balance shows the warning sentence; no balance says so; the line is absent on a failed read.

## Out of scope

- Moving float automatically: `b2b.transferFloat` is a planned send type, not built.
- A "balance history" chart: not asked for.
- Per-business balances: one pool per shortcode, as the plan says.
