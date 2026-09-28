#!/usr/bin/env bash
# =============================================================================
# SUPABASE RESTORE (doc 14 — recovery)
#
# Restores a backup produced by backup-supabase.sh into a TARGET database.
# The drill (doc 14: "restore tested") is: restore into a THROWAWAY Supabase
# project or local Postgres, run the row-count sanity queries, and record the
# result — never restore over the live production database without an
# explicit, dated incident decision.
#
# Usage:
#   TARGET_DB_URL="postgresql://postgres:PW@host:5432/postgres" \
#     bash scripts/restore-supabase.sh backups/2026-10-01-0330/<ref>/db.dump
#
# The script refuses to run without TARGET_DB_URL and prints the post-restore
# sanity checks for the drill record.
# =============================================================================
set -euo pipefail

DUMP="${1:?usage: restore-supabase.sh <path/to/db.dump>}"
: "${TARGET_DB_URL:?TARGET_DB_URL is required (throwaway target, never prod)}"

case "$DUMP" in
  /*) ;;
  *) DUMP="$(pwd)/$DUMP" ;;
esac
[ -f "$DUMP" ] || { echo "dump not found: $DUMP"; exit 1; }

echo "[restore] target: ${TARGET_DB_URL%%\?*}"
echo "[restore] dump:   ${DUMP}"
echo
echo "WARNING: this OVERWRITES schema+data in the target database."
echo "Confirm the target is NOT the production database."
read -r -p "Type 'restore' to continue: " CONFIRM
[ "$CONFIRM" = "restore" ] || { echo "aborted"; exit 1; }

pg_restore \
  --dbname "$TARGET_DB_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --jobs 4 \
  "$DUMP"

echo
echo "[restore] done. Drill sanity checks (record the output):"
echo "  psql \"${TARGET_DB_URL%%\?*}\" -c 'select count(*) from public.sites;'"
echo "  psql \"${TARGET_DB_URL%%\?*}\" -c 'select count(*) from public.inspections;'"
echo "  psql \"${TARGET_DB_URL%%\?*}\" -c 'select count(*) from public.audit_log;'"
echo "  psql \"${TARGET_DB_URL%%\?*}\" -c \"select max(created_at) from public.audit_log;\""
echo
echo "Expected: counts match the MANIFEST-verified source database and the"
echo "newest audit row is within the backup window."
