# Notifications web push — design (feature 12, second half)

Source: item 12 of the borrow list, "notifications web push", and the Blocked entry in
`/Users/ADEA/.claude/plans/dsh-reports.md`. Date 2026-09-17, version 0.28.0. The inbox itself
(feature 4, 0.20.0) is already live and does not change here; this adds the part that reaches the
owner when no Studio tab is open.

## What the owner gets

Press one button on the Notifications page and this device is told about the same lines the inbox
already writes: money sent and received, a send that failed or has no answer, a send waiting for a
second person, and an operator that stopped working. The line arrives with the same sentence the
inbox shows, and pressing it opens the payment or the inbox.

The button is per device and per browser, because that is how push works: a phone and a laptop each
opt in once, and turning it off on one leaves the other alone.

## The keys, and where they live

Web push signs with VAPID, so the deployment needs a key pair. It is generated on the VPS, into
`/root/ADEA/daraja-studio/src/deploy/.env` (mode 600, root), with
`npx web-push generate-vapid-keys`. The values are never printed, never copied into the repo,
never sent to a chat or a report, and never written to a tracked file. The repo only ever carries
the variable names:

| Variable | What it is |
|---|---|
| `STUDIO_VAPID_PUBLIC_KEY` | The public half. Not a secret: it goes to the browser so the browser can check that a push really came from this deployment. |
| `STUDIO_VAPID_PRIVATE_KEY` | The private half. Secret. Signs every push. |
| `STUDIO_VAPID_SUBJECT` | A contact address (`mailto:`) the push services can use if this deployment misbehaves. |

`deploy/docker-compose.yml` forwards all three to the container with the `${VAR:-}` shape the
file already uses, and `deploy/.env.example` documents them. Nothing else changes there.

**Absent means off, silently.** With no keys, `config.vapid` is null, and then: `GET /api/push/key`
answers `{ configured: false, publicKey: null }`, the Notifications page shows no button at all, no
service worker is registered, and the notification writer sends nothing. A half-filled or malformed
set logs one warning naming the variable and is treated as off — an optional feature must never keep
the site from booting. `/healthz` says `pushConfigured`, so the state is visible without a login.

## Table

Migration `server/migrations/029_push_subscriptions.sql`, following 026's structure (idempotent
DDL, RLS, GRANT):

```sql
push_subscriptions(
  id uuid pk default gen_random_uuid(),
  org_id uuid not null default app_current_org() references orgs(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  endpoint text not null,              -- the browser's own push address; a capability, so it is never logged
  p256dh text not null,                -- the browser's public key for this subscription
  auth text not null,                  -- the shared secret for this subscription
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failed_at timestamptz,
  failures int not null default 0 check (failures >= 0),
  gone_at timestamptz                  -- set when the push service says the address is dead
)
```

Indexes: `UNIQUE (org_id, endpoint)` (one row per browser subscription, and the conflict target
that lets the same browser switch person), and `(org_id, person_id) WHERE gone_at IS NULL` for the
sender's read. A dead address (`404` or `410` from the push service) is marked `gone_at`, and a
later subscribe with the same address revives the row with `gone_at = NULL`. Five failures in a row
mark it gone too: a subscription that never works must not be retried forever.

## Server

- `server/src/push/config.ts` — `vapidFromEnv(env)`, used by `config.ts`: all three or none,
  public key must be 87 base64url characters starting with `B`, private key 43, subject a
  `mailto:` or https address.
- `server/src/push/sender.ts` — `PushSender`, one method `send(subscription, message)` answering
  `'ok' | 'gone' | 'failed'`. `createVapidSender(vapid)` is the real one, wrapping `web-push`
  (a new server dependency). Tests pass a fake, so no test ever reaches a push service.
- `server/src/push/service.ts` — `createPushService({ db, vapid, sender? })`: `configured()`,
  `publicKey()`, `subscribe()`, `unsubscribe()`, `notify(classified)` and `sendTest(personId)`.
  `notify` walks the organisation's live subscriptions, prunes dead ones, and never throws: a push
  that fails must not cost the inbox its row.
- `server/src/push/routes.ts`, mounted at `/api/push`:

| Method | Path | Gate | Answer |
|---|---|---|---|
| GET | `/key` | session | `{ configured, publicKey }` |
| POST | `/subscribe` | session + CSRF | `{ devices }`; body `{ endpoint, keys: { p256dh, auth } }` |
| POST | `/unsubscribe` | session + CSRF | 204; body `{ endpoint }` |
| POST | `/test` | session + CSRF | `{ sent, failed }` to the caller's own devices; 409 when off |

  Subscribe and unsubscribe write one `audit_log` row each (`push.subscription_added`,
  `push.subscription_removed`) with no endpoint and no key material in the detail. Any signed-in
  person manages their own devices; the inbox has no permission of its own and this adds none.

- `server/src/notifications/writer.ts` gains an optional `push`, called after the inbox row is
  written. The push carries the same title and body as the inbox line, `tag` set
  to the dedupe key so a repeat replaces the earlier notification on the device instead of stacking,
  and a `url` that opens the payment when the line names one.

## Web

- `web/public/sw.js` — the service worker: `push` shows the notification (title, body, tag, icon);
  `notificationclick` brings an open Studio tab back to the front, or opens the line's own address
  when none is running. Plain JavaScript in `public/`, copied into the build as-is.
- The server sends `/sw.js` with `Cache-Control: no-cache` so a new worker is never a stale one.
- `web/src/api/push.ts` — the browser half: is push supported, what did the server say, what does
  the browser permission say, register the worker, subscribe with the public key, unsubscribe, send
  a test. Kept out of the page so it can be tested against stubs.
- `web/src/pages/Notifications.tsx` gains one card above the list: the button to turn notifications
  on for this device, the state when they are on ("Send a test", "Turn off on this device"), the
  plain sentence when the browser has been told no, and nothing at all when the deployment has no
  keys.
- Copy in `web/src/copy/en.ts` under `notifications.push`; guide task updated and
  `pnpm -C web guide:md` run.

## Tests

Server (`server/test/push.test.ts`, real PostgreSQL, fake sender, no network):
1. `vapidFromEnv` accepts a well-formed set, and answers null for none, half, or a malformed key.
2. With no keys: `/api/push/key` says `configured: false`, `/subscribe` and `/test` refuse, and the
   writer sends nothing.
3. `/subscribe` stores one device for the signed-in person, is idempotent for the same endpoint,
   and moves an endpoint to whoever subscribes it last.
4. The writer hands the fake sender the inbox line's title, body, tag and link.
5. A `410` marks the row gone and it is not sent to again; five failures in a row do the same.
6. A sender that throws does not stop the notification from being written.
7. Unsubscribe is idempotent, and a subscription belongs to its own organisation only.

Web (`web/src/test/push.test.tsx`): the page shows no button when the server has no keys; with keys
it subscribes and posts the subscription; a refused permission shows the sentence and does not post.

## Out of scope

- SMS or e-mail: the plan's phase 3, not asked for here.
- Per-category choices ("only failures"): the plan does not ask, and the browser itself can silence
  a site. The inbox filters stay the place to read selectively.
- Push for a person other than the one signed in: a subscription belongs to the person who made it.
