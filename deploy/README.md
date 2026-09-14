# Deploying daraja-studio

You need: a Linux box with Docker, a domain name pointing at it, and ports 80/443 open.

## 1. Recommended: Docker Compose with Caddy (automatic HTTPS)

    git clone https://github.com/kepas-tech/daraja-studio && cd daraja-studio/deploy
    cp .env.example .env
    # edit .env: POSTGRES_PASSWORD, STUDIO_DOMAIN, ACME_EMAIL, and STUDIO_SECRET_KEY from:
    #   docker run --rm node:20-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    docker compose up -d --build

Set `ACME_EMAIL` to a real address you control — Let's Encrypt sends certificate-expiry and
account notices there.

Open https://<your domain>. The first screen creates the owner.

Open the wizard right after the first boot. Until the owner account exists, whoever reaches the
address first can create it. (A one-time setup code is planned.)

## 2. No public IP: Cloudflare Tunnel

    docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d postgres studio backup

The `docker-compose.proxy.yml` override publishes `studio` on `127.0.0.1:8080` and keeps the
bundled Caddy from starting (no host ports 80/443). Point a Cloudflare Tunnel at `http://127.0.0.1:8080` for your hostname, forward
`X-Forwarded-Proto: https`, and set `STUDIO_PUBLIC_URL=https://<hostname>` in `deploy/.env`.

## 3. Already have nginx / Traefik / another proxy

    docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d postgres studio backup

Point your proxy at `http://127.0.0.1:8080`, forward `X-Forwarded-Proto: https`, and set
`STUDIO_PUBLIC_URL=https://<hostname>` in `deploy/.env`.

## STUDIO_TRUST_PROXY

`STUDIO_TRUST_PROXY=1` is required behind Caddy, Cloudflare Tunnel, or any other reverse proxy —
without it the server evaluates the proxy's own IP against the callback allowlist instead of the
real Safaricom source IP, and Daraja callbacks get quarantined as off-range. Count the hops that *add* an
`X-Forwarded-For` entry, not the boxes in the path: Caddy alone → `1`; Cloudflare's proxy (the
orange cloud) in front of a Cloudflare Tunnel → still `1`, because `cloudflared` passes the edge's
header through without adding a hop of its own (darajastudio.com ran `2` at first and a forged
header reached the loopback-only health fields until it was lowered to `1`); your own proxy behind
a CDN → `2`. The bundled `docker-compose.yml` sets `1`
for you; if you run `studio` behind your own proxy (option 3 above) or add a CDN in front of it,
set `STUDIO_TRUST_PROXY` yourself in `deploy/.env`. After deploying, confirm a forged
`X-Forwarded-For` header cannot reach the loopback-only health fields; if it can, lower
`STUDIO_TRUST_PROXY` by one.

## Safaricom callback allowlist

Studio only applies a Daraja callback whose source IP is on an allowlist, set under Settings →
Safaricom callback addresses. It ships pre-filled with the addresses Safaricom currently
publishes for Daraja go-live / IP whitelisting — you do not need to enter anything to get
started. When Safaricom announces new or changed addresses, update the list there.

## The `studio_app` database role

From version 0.3.0 the studio keeps every organisation's rows apart with PostgreSQL row-level
security. It connects as the user in `DATABASE_URL` and then becomes a limited role called
`studio_app`, which is deliberately not allowed to bypass those rules. The role is created by the
migration that runs at start-up, so with the bundled Compose file (where the studio owns its own
database) there is nothing to do.

On a **managed PostgreSQL** — Neon, Supabase, RDS, DigitalOcean, Hostinger's managed databases —
your user may not be allowed to create roles. The start-up log then prints exactly what an
administrator has to run once against the studio's database:

```sql
CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;
GRANT studio_app TO "your_database_user";
```

Restart the studio afterwards; the migration grants `studio_app` the table privileges it needs.

If the role is missing, a `single`-mode install still runs and prints that same warning at every
start: without the role, isolation rests on the application's own filters rather than on PostgreSQL
row-level security, which is fine for one organisation — every self-hosted install. A `hosted`
install refuses to start, because that safety net matters once more than one organisation shares
the database. `dbRoleOk` is shown only to loopback callers — neither your public domain nor a
host-side `curl 127.0.0.1:...` counts as loopback, so check from inside the container:

```bash
docker compose exec -T studio wget -qO- http://127.0.0.1:8080/healthz | grep dbRoleOk
```

`"dbRoleOk":true` means the studio is running under the limited role, as intended.

## Running the studio for more than one organisation

`STUDIO_MODE` exists so darajastudio.com can run this same image for many organisations; it is not
a choice for a self-hoster. Leave it unset (or `single`): your install is one organisation and
behaves exactly as it always has.

Setting `STUDIO_MODE=hosted` changes the product, not just a flag. It requires `STUDIO_PUBLIC_URL`
and `STUDIO_EGRESS_IPS` (the addresses Safaricom sees this service coming from — every production
organisation must ask Safaricom to whitelist them for its own shortcode), and it refuses to start if
the database role can bypass row-level security. It then mounts a public sign-up at
`/api/signup/*`, password recovery at `/api/auth/recover/*`, a host console at `/api/host/*` for
people in the first organisation who carry the host-admin flag, per-organisation rate limits, and an
hourly `org_expiry` job that closes any sign-up that has not been verified by Safaricom within 24
hours. None of that is mounted in `single` mode.

**Boot it once in `single` mode first.** There is no way to create the host organisation while
`STUDIO_MODE=hosted` — sign-up creates tenants, never the host. So: start the install with
`STUDIO_MODE` unset, open the address, finish the setup wizard (that is what marks the organisation
verified), and only then set `STUDIO_MODE=hosted` and restart. An install switched to hosted before
its wizard is finished has an organisation nobody can complete and no route to fix it.

The hosted switch needs three variables together, and the studio refuses to start without the last
two:

```
STUDIO_MODE=hosted
STUDIO_PUBLIC_URL=https://<your hostname>
STUDIO_EGRESS_IPS=<the address Safaricom sees this service coming from>
```

`STUDIO_EGRESS_IPS` is what every production organisation must ask Safaricom to whitelist for its own
shortcode; it appears in the sign-up wizard and in the explanation of every 403.002.1001.

`/api/people` is the one thing both modes share: the owner's page for adding colleagues with a role.

## Going live carefully

Add `STUDIO_MAX_SEND_CENTS=100` to `.env` before the first send with production credentials: every send is then capped at KES 1 by the server, whatever the page says. Send KES 1 to your own phone, confirm the result and the History row, then remove the cap.

Safaricom must be able to reach your public address for results to arrive. If you are testing from a laptop, `ngrok http 8080` gives a temporary https address; put it in Settings › Public address and press Test after every ngrok restart (the free hostname changes).

## Backups

The `backup` service writes a `pg_dump` every 24 hours (from container start) to the `backups`
volume and keeps 14 days. These backups live on the same host as the database — copy them off-box
(object storage, another machine) for real disaster recovery.
Keep `STUDIO_SECRET_KEY` somewhere safe as well: without it the stored Daraja credentials cannot be read and you will re-enter them.

Restore (dumps are `-Fc` custom format, not plain SQL — `psql` won't read them directly):

    docker compose stop studio
    docker compose cp backup:/backups/studio-<timestamp>.dump ./
    docker compose exec -T postgres pg_restore -U studio -d studio --clean --if-exists < studio-<timestamp>.dump
    docker compose start studio

### One organisation's data

`deploy/org-export.sh <org id>` writes a directory holding one CSV per table for that organisation
plus a `restore.sql` that replays them with `ON CONFLICT DO NOTHING`:

```bash
DATABASE_URL=postgres://studio:...@127.0.0.1:5432/studio ./deploy/org-export.sh <org id> ./backups
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ./backups/org-<id>-<timestamp>/restore.sql   # from inside that directory
```

To recover one organisation from a whole-database dump: restore the dump into a scratch database,
run the export there against that database, then replay the bundle into production. Existing rows
are never overwritten.

The files hold that organisation's encrypted Daraja credentials, so they are written mode 600 and
are only readable with the same `STUDIO_SECRET_KEY`.

**On a managed PostgreSQL**, take whole-database dumps with `pg_dump --enable-row-security` if you
connect as a user that row-level security applies to; without the flag `pg_dump` refuses to dump a
table it cannot read in full. The bundled Compose file connects as the database owner and needs
nothing extra.
## Updating

**Before updating to 0.3.0, take a backup you can actually go back to.** That version adds
organisations and row-level security to the database, and migration 007 is forward-only: once it
has run, a Phase 2 studio can no longer read the database.

```bash
# 1. A full machine snapshot (Hostinger VPS: Snapshots → Create snapshot; another provider's
#    equivalent), and
# 2. a database dump you can restore on its own:
docker compose exec -T postgres pg_dump -U studio studio | gzip > studio-before-0.3.0.sql.gz
```

Upgrade only to a released 0.3.0 build, never to a commit partway through it — a tree that has the
migration but not the boot wiring that follows it does not start. Then update as usual:

```bash
git pull && docker compose up -d --build
docker compose logs -f studio      # watch for: migrations applied: 007
docker compose exec -T studio wget -qO- http://127.0.0.1:8080/healthz
```

A successful upgrade logs `migrations applied: 007`, then `mode single, organisation <id>`, and
`/healthz` (read from inside the container, as above — a host curl or your public domain hides them)
answers with `"orgCount":1` and `"dbRoleOk":true`. Your callback address does not change:
the studio keeps the same secret it had before, so Safaricom needs no update.

To go back, restore the snapshot, or restore the dump into a fresh database and run the previous
image against it. Dropping the new tables by hand is not a supported downgrade.
