#!/usr/bin/env bash
# Back up the database and stored files into one timestamped directory.
#   scripts/backup.sh [destination]        default: ./backups
# Restore with scripts/restore.sh <backup-dir>.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
DEST="${1:-./backups}/keka-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"
# Custom format: compressed, and restorable selectively with pg_restore.
# Prisma URLs carry ?schema=…, which libpq does not accept.
pg_dump --format=custom --no-owner --file "$DEST/db.dump" "${DATABASE_URL%%\?*}"
if [ -d .storage ]; then tar -czf "$DEST/storage.tgz" .storage; fi
( cd "$DEST" && shasum -a 256 * > SHA256SUMS )
echo "Backed up to $DEST"
du -sh "$DEST"/*
