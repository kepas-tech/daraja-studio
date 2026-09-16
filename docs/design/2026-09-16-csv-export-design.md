# CSV export on History and Invoices — design (feature 3 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md`, priority item 3, and the order
brief. Date 2026-09-16, version 0.19.0. The permission `history.export` is already declared and
unused; this is its implementation.

## What the owner gets

A button on History and on Invoices that saves what is on the screen as a spreadsheet file: the
same rows the filters already select, in the same order. An accountant asks for a month of
payments; the owner picks the dates, presses Export, and sends the file.

## Server

`server/src/export/csv.ts` — one small writer, shared:

```ts
export function csvCell(value: unknown): string   // always quoted, inner " doubled
export function toCsv(header: string[], rows: unknown[][]): string
```

- Every cell is wrapped in double quotes and an inner quote is doubled, so a comma, a quote or a
  newline inside a name can never break the row.
- A cell whose text starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
  apostrophe. That is the spreadsheet formula guard: a customer called `=cmd|...` must land as
  text, never as a formula.
- Rows end with `\r\n`; the file ends with one newline. No byte-order mark: the file is UTF-8 and
  every modern spreadsheet reads it.

| Method | Path | Gate | Query | Answer |
|---|---|---|---|---|
| GET | `/api/requests/export.csv` | `history.export` | the same filters as `GET /api/requests`: `type`, `status`, `from`, `to`, `q`, `businessId`, `customerId` | `text/csv`, attachment |
| GET | `/api/invoices/export.csv` | `history.export` | `filter` (open, overdue, paid, cancelled, all), `q` | `text/csv`, attachment |

- Both reuse the existing WHERE builders (`listRequests` for requests, the invoice list query for
  invoices); no second definition of what a filter means. The export is never paged; it takes at
  most `EXPORT_MAX = 50_000` rows, newest first, and stops there.
- `Content-Disposition: attachment; filename="history-YYYY-MM-DD.csv"` (the day the file was made),
  `Cache-Control: no-store`.
- Every export writes one `audit_log` row (`history.exported`, `invoices.exported`) carrying the
  filters the person used — never the rows, never a phone number in the audit text.

### Columns

History: When, What, To (the phone or shortcode), Name (the saved contact or the customer, else
Safaricom's), Business, Amount, Status, Receipt, Note, Who made it.

Invoices: Reference, Customer, Phone, Invoice name, Account reference, Billed period, Due date,
Amount, Paid, Status, Sent, Paid at.

The phone numbers and receipts are the owner's own data, in a file the owner asked for; this is not
a log and nothing is written to the studio's logs. That is the deliberate reading of "never log
phone numbers or receipts": logging is the thing that is banned, an export the owner pressed for is
the product.

## Web

- History: an "Export as a spreadsheet" button beside the filters, shown only to somebody who is
  the owner or holds `history.export`; it sends every filter currently on the page.
- Invoices: the same button beside its filter and search.
- `web/src/api/client.ts` gains `download(path)`: fetch with the session cookie, read
  `Content-Disposition` for the file name when the server sent one, and hand back a Blob. The page
  turns it into a temporary object URL and clicks a hidden `<a download>`, then revokes it. A
  failed download shows the usual explained error, not a blank page.
- Copy in `web/src/copy/en.ts`: `history.export`, `history.exporting`, `history.exported`,
  `invoices.export`, and one line for a refusal. Guide: a short task under History, plus the
  machine copy lines for the two routes.

## Tests

Server (`server/test/export.test.ts`, real PostgreSQL):
1. Without `history.export` the request is 403; the owner's is 200 with
   `text/csv` and an attachment file name.
2. The header line is exactly the documented columns; one request row appears once.
3. Filters are honoured: a status filter and a date range change the rows, and a business filter
   (feature 2) narrows to that business.
4. Quoting: a remark with a comma and a double quote round-trips through the file.
5. The formula guard: a name beginning with `=` lands with the leading apostrophe.
6. Invoices: the open filter leaves a paid invoice out; the file carries the paid amount.
7. Each export writes one audit row naming the filters and no phone number.

Web (`web/src/test/export.test.tsx`): the button is absent without the permission and present with
it; pressing it fetches the export URL with the filters on the page; a failure shows the explained
error.

## Out of scope

- Scheduled or emailed exports: not asked for.
- Exporting other pages: only History and Invoices are in the plan.
- Excel-native formats: CSV opens everywhere and needs no dependency.
