#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="backups/neutrino-${stamp}.dump"
temporary_file=$(mktemp backups/.backup.XXXXXX)
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
docker compose exec -T db pg_dump -U neutrino -d neutrino --format=custom > "$temporary_file"
mv "$temporary_file" "$backup_file"
printf 'Backup saved: %s\n' "$backup_file"
