# daraja-studio

Simplified console for your M-Pesa shortcode. Self-hosted, open source, built on
[@kepas/daraja-js](https://github.com/kepas-tech/daraja-js).

Status: v0.14.4. One install = one organisation = one shortcode: Studio mirrors the Safaricom
organisation portal wherever the Daraja API allows, exposes the whole `@kepas/daraja-js` surface,
and lists what the API cannot do.

Current work and remaining features: [Roadmap](docs/ROADMAP.md).

## Features

- **Send money** — B2C payments to a phone number, with duplicate protection, review and live results.
- **Balances, Lookup and History** — account balance, receipt lookup, and a full history in Safaricom's own words.
- **Settings** — Daraja credentials, shortcode, operator, callback address and B2C API version, per environment (sandbox/production).
- **Setup wizard** — takes a new install from empty database to verified in a few steps; **Go live**
  later takes a Sandbox studio to real money the same way, one screen at a time.
- **How to use** — the manual, inside the app at `/guide`. Source: `web/src/copy/guide.ts`.
- **Hosted mode** — run Studio as a service for many organisations: sign-up verified by real
  Safaricom calls, email confirmation by code or link, login by e-mail, people and roles, owner recovery, a read-mostly host console,
  and per-organisation rate limits.

## Hosted signup email

New hosted owners confirm access to their email before entering Daraja credentials. Each email has
one six-digit code and a confirmation link; either works once within 10 minutes. Resending replaces
both. Existing accounts keep access; they are not marked email-confirmed by the upgrade.

Set `STUDIO_PUBLIC_URL` and all five `STUDIO_SMTP_*` values in `deploy/.env` as shown in
[the example](deploy/.env.example). SMTP uses authenticated TLS on port 465 or 587 and checks the
server certificate. Use a dedicated sender with SPF, DKIM and DMARC records. Hosted signup needs
mail configured; a delivery failure leaves the account waiting with a resend option. Migration
010 runs at startup. Take a database backup before upgrading. Exported organisation bundles omit
short-lived email challenges; a restored pending owner requests a new email.

## Run locally

    docker compose -f deploy/docker-compose.dev.yml up -d
    pnpm install
    cp deploy/.env.example .env
    pnpm dev

Two optional settings worth knowing before real money is involved:

- `STUDIO_MAX_SEND_CENTS=100` caps every single send at KES 1, server-side. Set it on any installation that runs with real credentials until you trust it; unset it when you do.
- `STUDIO_FAKE_SAFARICOM=1` (development only) answers every Daraja call in-process and posts the callbacks back to the app, so you can walk Send money, Balances, Lookup and History without a Safaricom account. It is refused when `NODE_ENV=production`.
- B2C API version is chosen per environment in Settings — automatic by default (Studio finds out which one your app can use and remembers it), or force v1/v3 if you already know.

Open http://localhost:5173. The server listens on http://localhost:8080.

## Keeping your own details out of the repo

Sample data in tests is made up. Put your real paybill or till number, phone numbers, names,
operator usernames and app names in the repo-root `.env` (git-ignored) as
`STUDIO_PRIVATE_STRINGS=a,b,c`; `server/test/private-strings.test.ts` then fails the suite if any
of them appears in a tracked file.

## Deploy

See [`deploy/README.md`](deploy/README.md) for Docker Compose (Postgres + Caddy + backups every
24 hours), Cloudflare Tunnel, and reverse-proxy setups.

## AI assistance

Parts of this codebase were written with the assistance of AI coding tools, under human direction
and review. Every code change passes the project's typecheck, lint and test suite before it lands.

## Licence

Elastic License 2.0. Free to self-host and modify; not for offering as a hosted or managed service
to third parties. Not affiliated with Safaricom PLC.
