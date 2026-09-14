#!/bin/sh
# pg_dump every 24 hours from container start; keeps 14 days.
while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  if pg_dump -h postgres -U studio -d studio -Fc -f "/backups/studio-$ts.dump"; then
    echo "backup ok $ts"
    find /backups -name 'studio-*.dump' -mtime +14 -exec rm -f {} +
  else
    echo "BACKUP FAILED $ts" >&2
  fi
  sleep 86400
done
