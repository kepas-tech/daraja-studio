# The marketing page for darajastudio.com

One page, static, no build step and no JavaScript. It says what Daraja Studio is, who each of the
three shapes suits, where the guide is, and how somebody with their own paybill starts. It is served
by its own `nginx:alpine` container on the loopback, not by the studio, so the product and its
advertisement never share a process.

## Where it runs

| | |
|---|---|
| Server | `srv492279` (62.72.3.138) |
| Compose project | `daraja-marketing`, from this directory |
| Container | `daraja-marketing` |
| Loopback port | `127.0.0.1:8095` |
| Page and files | `./site` → `/usr/share/nginx/html` (read-only) |
| Config | `./nginx.conf` → `/etc/nginx/conf.d/default.conf` (read-only) |

The deploy sync leaves this directory at `/root/ADEA/daraja-studio/src/marketing`, and that is
where the stack is started from. It is also in the fifth wave of the startup orchestrator, so a
reboot brings it up with the rest.

Start it, or pick up a changed `nginx.conf` or compose file:

    cd /root/ADEA/daraja-studio/src/marketing
    docker compose up -d

The page is a bind mount: a deploy that only changes `site/` is live at once, with no restart.

## The Cloudflare route to add (the owner's to make, not the agent's)

`darajastudio.com` and `www.darajastudio.com` point at the studio on `127.0.0.1:8080` today.
They should point here, with the callback and machine paths still answered by the studio: three
rules per hostname, in this order.

| # | Path rule | Service |
|---|---|---|
| 1 | `^/cb` | `http://127.0.0.1:8080` — the studio |
| 2 | `^/api/money-in/feed` | `http://127.0.0.1:8080` — the studio |
| 3 | everything else | `http://127.0.0.1:8095` — this page |

Rule 2 is there because kepas-pay posts each confirmation to `/api/money-in/feed` at the old
address, and a POST that lands on a redirect is a POST that breaks. A GET on an old path still
reaches the studio anyway: this page sends it on with its path and query (see `nginx.conf`).

When the two-week callback window closes on 4 October, rule 1 comes out, and the old address is
this page and nothing else.

## What leaves the studio's configuration, and when

The studio's own rule — `STUDIO_REDIRECT_OLD_ADDRESSES` and `STUDIO_REDIRECT_UNTIL` in
`src/deploy/.env` — has nothing left to redirect the moment rule 3 is in place, because a request
on those hostnames no longer reaches the studio at all. Take both lines out and recreate the studio
container in the same change as the route:

    # in /root/ADEA/daraja-studio/src/deploy/.env, delete these two lines:
    #   STUDIO_REDIRECT_OLD_ADDRESSES=darajastudio.com
    #   STUDIO_REDIRECT_UNTIL=2026-10-03T21:00:00Z
    cd /root/ADEA/daraja-studio
    docker compose up -d --no-deps studio

The code keeps the feature; only the two values go. Leave them alone until the route moves: they are
what sends readers from the old address to the studio today.

## What the page may say

The product's own rules: plain English, and nothing the product cannot do today. No plans, no
billing, no wallets, no schedules, and nothing with a "soon" on it. The hosted service has no public
sign-up, so that shape gets a sentence and an address to write to, never a button that does nothing.
The copy is checked with `node ~/.dsh/ai-style/guard.mjs` before it is committed.

## Checking it without the route

    curl -sS -D- -o /dev/null http://127.0.0.1:8095/                             # 200, text/html
    curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8095/assets/logo-long.png
    curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' 'http://127.0.0.1:8095/history?range=7'
    curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8095/cb/not-a-secret/selftest

The third is an old bookmark: 301 to the same path on the studio. The fourth is a callback path: 404
here, and answered by the studio through rule 1 while the window is open.
