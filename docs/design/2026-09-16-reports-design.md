# Reports, and the Home strip — design (feature 6 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md` section C (Analytics) and priority
item 6; the order brief. Date 2026-09-16, version 0.22.0. Profit and cost are dropped: Studio sells
nothing, so there is no margin to show.

## What the owner gets

One page that answers "how did the week go": money in and money out per day, how many payments went
through, and why the rest failed. A window selector (7, 30 or 90 days), the business filter every
list already has, and the table as a spreadsheet. Home gets the last 24 hours.

## Which rows count

| Direction | Types |
|---|---|
| Money in | `c2b`, `stk`, `ratiba`, `express`, `bonga`, `invoice_payment` |
| Money out | `b2c`, `reversal` |

`balance` and `status_query` rows are housekeeping, never money, and never appear. A day is a
Nairobi day (`AT TIME ZONE 'Africa/Nairobi'`), the day the owner's own clock is on.

- **Success rate** = completed ÷ (completed + failed) among the rows of that day, both directions.
  A row that never got an answer is counted in its own `unknown` column and left out of the rate,
  because calling "we do not know yet" a failure would be a lie and calling it a success would be
  worse. The page says which two numbers the rate is made of.
- **Why things failed — last 7 days**: failed rows grouped by Safaricom's own `result_desc`
  (the reason column), each with a count and the shillings it affected. Empty reasons are grouped
  under one plain line rather than dropped.

## API — `server/src/reports/routes.ts`, mounted at `/api/reports`

Everything here is a read: no permission beyond a session and `lookup.view`, which every role
preset already has and which History already trusts with both directions.

| Method | Path | Query | Answer |
|---|---|---|---|
| GET | `/api/reports` | `days=7\|30\|90` (default 7), `businessId` | the view below |
| GET | `/api/reports/summary` | — | the last 24 hours, for Home |
| GET | `/api/reports/export.csv` | same query as `/` | the per-day table as a spreadsheet (`history.export`) |

```ts
interface ReportsView {
  window: { days: number; from: string; to: string };            // Nairobi days, inclusive
  days: { day: string; inCents: number; inCount: number;
          outCents: number; outCount: number;
          completed: number; failed: number; unknown: number }[];
  totals: { inCents: number; inCount: number; outCents: number; outCount: number;
            completed: number; failed: number; unknown: number };
  failures: { reason: string; count: number; amountCents: number }[];   // last 7 days, biggest first
  byBusiness: { businessId: string; code: string; name: string; inCents: number; outCents: number }[];
}
interface HomeSummary {
  inCents: number; inCount: number; outCents: number; outCount: number;
  pending: number; failed: number;
}
```

- `byBusiness` is filled only when the caller did not pick a business and the organisation has two
  or more: it is the same picture Home shows, for the chosen window.
- Days with no rows are returned with zeros, so the table has one line per day in the window and a
  gap is visible as a gap. 90 days is 90 rows, which is why the CSV matters.
- An unknown `days` value is a 400 in plain English, never a silent default.

## Web

- `web/src/pages/Reports.tsx` at `/reports`, nav entry under Home with the `document-report` icon;
  Businesses moves to the `grid-3` icon so two menu lines never wear the same one.
- The page: window selector (7 / 30 / 90 days), business filter, a totals line, the per-day table,
  "Why things failed — last 7 days", and the export button for whoever holds `history.export`.
- Home gains a 24-hour strip: "In KES X from n payments · Out KES Y to n payments" and a second
  line "n waiting · n failed". It reads `/api/reports/summary` once and refreshes on
  `request.updated` like the rest of Home. The balance line ("Balance KES X · waiting to go out
  KES Y") is item 9 and is left for it: the strip and the balance line are separate rows.
- Copy in `web/src/copy/en.ts` under `reports` and `home.today`; guide task; `pnpm -C web guide:md`.

## Tests

Server (`server/test/reports.test.ts`):
1. A day with one completed c2b, one completed b2c and one failed b2c totals correctly, and the
   success rate is 2 of 3.
2. An unknown row lands in its own column and leaves the rate alone.
3. Balance and status-query rows never appear.
4. Days with nothing are present with zeros; the window has exactly `days` lines.
5. The failure list groups by reason, biggest first, with the amount summed.
6. The business filter narrows the numbers; `byBusiness` is filled only without a filter.
7. `summary` counts the last 24 hours only.
8. The CSV carries the per-day header and one line per day, behind `history.export`.
9. A bad `days` value is 400; a person without `lookup.view` is 403.

Web (`web/src/test/reports.test.tsx`): the table renders the days and totals; the window selector
re-asks with the new days; the failure list shows reason, count and amount; the export button is
permission-gated; Home shows the 24-hour strip.

## Out of scope

- Profit, cost or margin: Studio sells nothing.
- Charts: the numbers are the product; a table prints and exports, a chart does not.
- Scheduled report emails: not asked for.
