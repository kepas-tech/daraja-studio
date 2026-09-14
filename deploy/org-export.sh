#!/usr/bin/env sh
# Export one organisation's rows as a bundle that can be replayed into another database.
#
# Usage:  DATABASE_URL=postgres://... ./deploy/org-export.sh <org id> [output directory]
#         docker compose exec -T postgres sh -c 'DATABASE_URL=... /path/org-export.sh <org id>'
#
# Writes <output directory>/org-<id>-<timestamp>/ holding one CSV per table plus restore.sql.
# Spec section 10.10. Never prints a row; the files hold encrypted secrets, so they are mode 600.
set -eu
umask 077

ORG_ID="${1:-}"
OUT_ROOT="${2:-.}"
if [ -z "$ORG_ID" ]; then
  echo "usage: org-export.sh <org id> [output directory]" >&2
  exit 2
fi
: "${DATABASE_URL:?set DATABASE_URL to the studio database}"

# Same style as the missing-org refusal: a bad id exits 1 before it is interpolated into SQL.
case "$ORG_ID" in *[!0-9a-fA-F-]*) echo 'org id must be a uuid' >&2; exit 1 ;; esac
if ! printf '%s\n' "$ORG_ID" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "org id must be a uuid: $ORG_ID" >&2
  exit 1
fi

# Every table with an org_id column (migration 007), plus the orgs row itself. `jobs` carries its
# organisation inside payload rather than in a column, and `cache` is a global table keyed by a
# prefix — the running service rebuilds both, so neither is exported.
# Email challenges are short-lived and excluded; a restored pending owner requests a new email.
TABLES="settings people permissions sessions operators requests balances callbacks_raw audit_log"

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT_ROOT"
DIR=$(mktemp -d "$OUT_ROOT/org-$ORG_ID-$TS-XXXXXX")
SUCCESS=0
trap 'if [ "$SUCCESS" = 0 ]; then rm -rf "$DIR"; fi' 0
trap 'exit 1' 1 2 15

# app.role=system: on the bundled Compose file DATABASE_URL's user is a superuser and bypasses
# row-level security anyway, but on a managed PostgreSQL it can be an ordinary table owner, and
# FORCE ROW LEVEL SECURITY applies to owners too — without this the files would come out empty.
# Every COPY uses the same transaction snapshot. A live write between tables cannot leave a
# permission whose person was absent from the earlier file. Relative filenames also keep the
# caller's output path out of SQL, including paths containing quotes or spaces.
{
  echo 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'
  echo "SELECT set_config('app.role', 'system', true);"
  printf "\\\\copy (SELECT * FROM orgs WHERE id = '%s') TO 'orgs.csv' WITH (FORMAT csv, HEADER true)\n" "$ORG_ID"
  for t in $TABLES; do
    printf "\\\\copy (SELECT * FROM %s WHERE org_id = '%s') TO '%s.csv' WITH (FORMAT csv, HEADER true)\n" "$t" "$ORG_ID" "$t"
  done
  echo 'COMMIT;'
} > "$DIR/export.sql"
(cd "$DIR" && psql "$DATABASE_URL" --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f export.sql >/dev/null)
rm "$DIR/export.sql"
if [ "$(wc -l < "$DIR/orgs.csv")" -lt 2 ]; then
  echo "no organisation with id $ORG_ID" >&2
  rm -rf "$DIR"
  exit 1
fi

# The replay: stage each CSV in a temporary table shaped like the real one, then insert from it.
# ON CONFLICT DO NOTHING is why this is not a plain COPY — a restore must never overwrite a row
# that already exists in the target database.
{
  echo "-- Replay this organisation into another studio database:"
  echo "--   psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f restore.sql"
  echo "-- Run it from inside this directory. Existing rows are left exactly as they are."
  echo "BEGIN;"
  echo "SELECT set_config('app.role', 'system', false);"
  for t in orgs $TABLES; do
    echo "CREATE TEMP TABLE stage_$t (LIKE public.$t INCLUDING DEFAULTS) ON COMMIT DROP;"
    printf "\\\\copy stage_%s FROM '%s.csv' WITH (FORMAT csv, HEADER true)\n" "$t" "$t"
    echo "INSERT INTO public.$t SELECT * FROM stage_$t ON CONFLICT DO NOTHING;"
  done
  # audit_log carries an explicit bigserial id: the replay above inserted the exported ids, so the
  # sequence must advance past the highest one or the next append (an audit of the restore itself)
  # collides with the append-only trigger's refusal to let anything fix it afterwards.
  echo "SELECT setval(pg_get_serial_sequence('public.audit_log','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM public.audit_log), 1));"
  echo "COMMIT;"
} > "$DIR/restore.sql"

chmod 600 "$DIR"/*.csv "$DIR/restore.sql"
SUCCESS=1
echo "$DIR"
