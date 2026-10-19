#!/usr/bin/env bash
# Session 10 — LOCAL restore drill (no cloud credentials needed).
#
# Builds a throwaway Postgres cluster, applies the platform stub + every
# supabase/migrations/*.sql in order, loads a small fixture, takes a custom-
# format pg_dump (the same format backup.yml produces), restores it into a
# SECOND fresh database exactly like backup.yml's drill, and compares row
# counts + schema object counts between source and restore.
#
# What this proves: the migration set + a pg_dump/pg_restore round trip
# preserve schema objects and row data on Postgres 16.
# What it does NOT prove: that the production Supabase project's backup
# artifact restores (that is backup.yml's weekly job against the real dump).
#
# Needs: postgresql-16 binaries (initdb, pg_ctl, psql, pg_dump, pg_restore).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d)"; PORT="${DRILL_PORT:-55433}"
cleanup() {
  if [ "$(id -u)" = 0 ]; then su drill -c "'$PGBIN/pg_ctl' -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true
  else "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
OUT="${1:-/dev/stdout}"

if [ "$(id -u)" = 0 ]; then
  id drill >/dev/null 2>&1 || useradd -m drill
  chown -R drill "$WORK"; AS=(su drill -c)
  run() { su drill -c "$*"; }
else
  run() { bash -c "$*"; }
fi
run "'$PGBIN/initdb' -D '$WORK/data' -U postgres --auth=trust >/dev/null"
run "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $PORT -k $WORK' -l '$WORK/log' -w start >/dev/null"
P="-h $WORK -p $PORT -U postgres"
q() { "$PGBIN/psql" $P -v ON_ERROR_STOP=1 -X -q "$@"; }

q -d postgres -c "create database source" -c "create database restored"
q -d source -f "$HERE/scripts/drill-platform-stub.sql" >/dev/null
for f in "$HERE"/supabase/migrations/*.sql; do q -d source -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; exit 1; }; done
q -d source -f "$HERE/supabase/seeds/liberia_boundaries_geoboundaries.sql" >/dev/null 2>&1 || echo "(boundary seed skipped)"
q -d source -f "$HERE/scripts/drill-fixture.sql" >/dev/null

COUNTS="select 'rowcount|'||t||'|'||c from (
 select 'sites' t,(select count(*) from public.sites) c union all
 select 'profiles',(select count(*) from public.profiles) union all
 select 'inspection_templates',(select count(*) from public.inspection_templates) union all
 select 'inspections',(select count(*) from public.inspections) union all
 select 'community_reports',(select count(*) from public.community_reports) union all
 select 'audit_log',(select count(*) from public.audit_log) union all
 select 'risk_config_versions',(select count(*) from public.risk_config_versions) union all
 select 'admin_boundaries',(select count(*) from public.admin_boundaries) union all
 select 'auth.users',(select count(*) from auth.users)) x
 union all select 'schema|tables|'||count(*) from pg_tables where schemaname='public'
 union all select 'schema|policies|'||count(*) from pg_policies where schemaname='public'
 union all select 'schema|triggers|'||count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname='public'
 union all select 'schema|routines|'||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1"
q -d source -tA -c "$COUNTS" > "$WORK/source.txt"

"$PGBIN/pg_dump" $P -d source -Fc --no-owner --no-privileges -f "$WORK/db.dump"
"$PGBIN/pg_restore" --list "$WORK/db.dump" >/dev/null
# platform roles are cluster-level and not in the dump (backup.yml does the same)
q -d restored <<'SQL'
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin',
    'supabase_auth_admin','supabase_storage_admin','dashboard_user','supabase_read_only_user',
    'supabase_replication_admin','pgbouncer'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop; end $$;
SQL
"$PGBIN/pg_restore" $P -d restored --no-owner --no-privileges "$WORK/db.dump" 2> "$WORK/restore.err" || echo "pg_restore non-fatal errors: $(grep -c . "$WORK/restore.err") lines"
q -d restored -tA -c "$COUNTS" > "$WORK/restored.txt"
# Only cluster-level roles pre-exist in the target (as in backup.yml); any
# pg_restore error that is not an "already exists" on a role is reported.
OTHER_ERR="$(grep -E '^pg_restore: error' "$WORK/restore.err" | grep -vcE 'already exists' || true)"

{
  echo "=== SOURCE $(date -u +%FT%TZ) ($("$PGBIN/postgres" --version)) ==="; cat "$WORK/source.txt"
  echo "=== RESTORED ==="; cat "$WORK/restored.txt"
  echo "restore_errors_other_than_already_exists|${OTHER_ERR:-0}"
  grep -E '^pg_restore: error' "$WORK/restore.err" | grep -vE 'already exists' | sed 's/^/restore_error_detail|/' | head -10 || true
  echo "dump_bytes|$(stat -c %s "$WORK/db.dump")"
  if diff -q "$WORK/source.txt" "$WORK/restored.txt" >/dev/null; then echo "RESULT|PASS|source and restored counts identical"; else echo "RESULT|FAIL"; diff "$WORK/source.txt" "$WORK/restored.txt"; exit 1; fi
} | tee "$OUT"
