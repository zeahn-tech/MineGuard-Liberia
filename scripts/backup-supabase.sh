#!/usr/bin/env bash
# =============================================================================
# SUPABASE BACKUP (doc 14 — backup schedule)
#
# One backup = a pg_dump of the production database plus a manifest with its
# SHA-256 checksum, written to a dated directory:
#   backups/YYYY-MM-DD-HHMM/<project-ref>/db.dump
#
# Used by two callers:
#   1. .github/workflows/backup.yml — nightly scheduled run (retains 90 days
#      of artifacts).
#   2. .github/workflows/deploy-production.yml — forced fresh backup before
#      every production deploy (never deploy on a stale recovery point).
#
# Restore: scripts/restore-supabase.sh (documented drill in doc 14).
#
# Required environment:
#   SUPABASE_PROJECT_REF   production project ref (from supabase dashboard)
#   SUPABASE_DB_PASSWORD   production database password
#
# The script performs NO third-party upload: the dump lands in ./backups on
# the caller (CI workspace), and retention is artifact-based. Copying to
# object storage is an operator/owner decision (cost + residency).
# =============================================================================
set -euo pipefail

DEST_ROOT="${1:-./backups}"
STAMP="$(date -u +%Y-%m-%d-%H%M)"

: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"
: "${SUPABASE_DB_PASSWORD:?SUPABASE_DB_PASSWORD is required}"

DEST_DIR="${DEST_ROOT}/${STAMP}/${SUPABASE_PROJECT_REF}"
mkdir -p "$DEST_DIR"

DUMP_PATH="${DEST_DIR}/db.dump"

echo "[backup] dumping project ${SUPABASE_PROJECT_REF} at ${STAMP}Z"
# Supabase DB host pattern (session pooler on port 5432 for pg_dump):
DB_HOST="aws-0-${SUPABASE_PROJECT_REF}.pooler.supabase.com"
# The direct host form used by Supabase's own CLI is:
#   db.<project-ref>.supabase.co — try direct first, fall back to pooler.
if ! pg_isready -h "db.${SUPABASE_PROJECT_REF}.supabase.co" -p 5432 -t 5 >/dev/null 2>&1; then
  DB_HOST="db.${SUPABASE_PROJECT_REF}.supabase.co"
fi

PGPASSWORD="$SUPABASE_DB_PASSWORD" pg_dump \
  -h "db.${SUPABASE_PROJECT_REF}.supabase.co" \
  -p 5432 \
  -U postgres \
  -d postgres \
  -Fc \
  -f "$DUMP_PATH"

SIZE="$(du -h "$DUMP_PATH" | cut -f1)"
SHA="$(sha256sum "$DUMP_PATH" | cut -d' ' -f1)"

cat > "${DEST_DIR}/MANIFEST.txt" <<EOF
mineguard-liberia backup
timestamp_utc: ${STAMP}
project_ref:   ${SUPABASE_PROJECT_REF}
tool:          pg_dump -Fc (custom format; restore via restore-supabase.sh)
size:          ${SIZE}
sha256:        ${SHA}
EOF

echo "[backup] wrote ${DUMP_PATH} (${SIZE}, sha256 ${SHA:0:12}…)"

# Verify the dump is loadable metadata-wise (list contents) — a corrupt or
# empty archive fails the caller loudly instead of surfacing at restore time.
pg_restore --list "$DUMP_PATH" >/dev/null
echo "[backup] archive verified (pg_restore --list ok)"

# Retention: prune local backups older than 90 days when pruning is enabled.
if [ "${BACKUP_PRUNE_OLDER_THAN_DAYS:-0}" -gt 0 ] 2>/dev/null; then
  find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$BACKUP_PRUNE_OLDER_THAN_DAYS" -exec rm -rf {} \;
  echo "[backup] pruned local backups older than ${BACKUP_PRUNE_OLDER_THAN_DAYS} days"
fi

# Emit the artifact name for CI callers (stable, collision-free per run).
BASENAME="db-backup-${STAMP}-${SUPABASE_PROJECT_REF:0:8}"
echo "${BASENAME}"
