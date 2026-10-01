#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into the database in .env.
#   scripts/restore.sh <backup-dir> [--yes]
# Verifies checksums first. Replaces every table it restores.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
SRC="${1:?usage: scripts/restore.sh <backup-dir> [--yes]}"
# Restore somewhere else (a staging copy, a drill) with RESTORE_DATABASE_URL.
TARGET="${RESTORE_DATABASE_URL:-$DATABASE_URL}"
TARGET="${TARGET%%\?*}"
( cd "$SRC" && shasum -a 256 -c SHA256SUMS )
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This overwrites the database at $TARGET. Type RESTORE to continue: " ok
  [ "$ok" = "RESTORE" ] || { echo "Aborted."; exit 1; }
fi
pg_restore --clean --if-exists --no-owner --dbname "$TARGET" "$SRC/db.dump"
if [ -f "$SRC/storage.tgz" ] && [ -z "${RESTORE_DATABASE_URL:-}" ]; then rm -rf .storage && tar -xzf "$SRC/storage.tgz"; fi
echo "Restored from $SRC. Restart the app so it reconnects."
