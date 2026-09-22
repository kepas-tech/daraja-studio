#!/usr/bin/env bash
# The deploy preflight. Run it before the rsync that ships this tree to the server.
#
# A migration file whose mode leaves it unreadable to the user Studio runs as has taken the live site
# down before: `rsync -az` preserves modes, the Dockerfile copies them into the image, and the
# runtime drops to the `studio` user — so a file written 600 arrives 600 and the boot dies on EACCES.
# This is the check that catches it before any of that happens.
#
# What it does, per migration file:
#   - readable here but not mode 644: normalised to 644, and reported by name. This is the incident
#     that happened twice, and it is fixed rather than merely complained about.
#   - not readable here at all: refused, named, with the one command that fixes it. Nothing is
#     guessed about such a file (another owner, a read-only mount, or a file locked on purpose are
#     all possible), so a person looks at it.
#
# Usage:
#   deploy/preflight.sh                        # the core's migrations, and the package's when it is beside this checkout
#   deploy/preflight.sh --extension <dir>      # say where the package's migrations are
#   STUDIO_EXTENSION_MIGRATIONS=<dir> deploy/preflight.sh
#
# Exit: 0 when every migration is readable and 644; 1 with the files named when one is not.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
core="$root/server/migrations"
extension="${STUDIO_EXTENSION_MIGRATIONS:-}"
extension_asked=0

usage() {
  echo "Usage: deploy/preflight.sh [--core <dir>] [--extension <dir>]"
  echo "Normalises every migration file to mode 644, and refuses when one cannot be read."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --core) [ $# -ge 2 ] || { echo "preflight: --core needs a directory." >&2; exit 2; }; core="$2"; shift 2 ;;
    --extension) [ $# -ge 2 ] || { echo "preflight: --extension needs a directory." >&2; exit 2; }; extension="$2"; extension_asked=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "preflight: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# The package's own directory, when it sits beside this checkout and the caller did not say.
if [ -z "$extension" ] && [ -d "$root/../studio-host/migrations" ]; then
  extension="$root/../studio-host/migrations"
fi

mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || echo '?'; }

failed=0
count=0
normalised=""

refuse() { echo "preflight: $1" >&2; failed=1; }

check_dir() {
  label="$1"
  dir="$2"
  required="$3"
  if [ ! -d "$dir" ]; then
    if [ "$required" = yes ]; then refuse "the $label migrations directory $dir does not exist."; fi
    return
  fi
  if [ ! -r "$dir" ] || [ ! -x "$dir" ]; then
    refuse "the $label migrations directory $dir cannot be read and searched."
    return
  fi
  for f in "$dir"/*.sql; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      [0-9][0-9][0-9]_*.sql) ;;
      *) continue ;;
    esac
    count=$((count + 1))
    if [ ! -r "$f" ]; then
      refuse "$f is not readable (mode $(mode_of "$f")). Fix it before deploying: chmod 644 '$f'"
      continue
    fi
    case "$(mode_of "$f")" in
      644|0644) ;;
      *) if chmod 644 "$f" 2>/dev/null && [ -r "$f" ]; then
           normalised="$normalised $(basename "$f")"
         else
           refuse "$f could not be made readable (mode $(mode_of "$f")). Fix its mode or its owner before deploying."
         fi ;;
    esac
  done
}

check_dir core "$core" yes
if [ -n "$extension" ]; then
  check_dir extension "$extension" "$extension_asked"
else
  echo "preflight: no extension migrations directory was given, and none is beside this checkout."
fi

if [ "$failed" != 0 ]; then
  echo "preflight: refusing to deploy while a migration above would not be readable inside the image." >&2
  exit 1
fi
if [ -n "$normalised" ]; then
  echo "preflight: normalised to 644:$normalised"
fi
echo "preflight: $count migration file(s) are readable and 644."
exit 0
