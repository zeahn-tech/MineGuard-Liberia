-- ============================================================================
-- POST-DEPLOY VERIFICATION for migration 0065 (psql version). Run it from the REPOSITORY ROOT:
--   psql "$DATABASE_URL" -f supabase/maintenance/verify_0065.sql
-- Part 1 is the read-only editor script (every row PASS; REVIEW rows are explained in docs/27). Part 2 are write probes: each runs
-- inside a block that always rolls back its own change, and prints PASS or raises FAIL.
-- ============================================================================
\echo '== PART 1: read-only checks (same as verify_0065_editor.sql)'
\i supabase/maintenance/verify_0065_editor.sql

\echo '== PART 2a: sites.code immutability rejects an update (rolled back whatever happens)'
do $v$
declare v_id uuid; v_ok boolean := false;
begin
  select id into v_id from public.sites limit 1;
  if v_id is null then raise notice 'SKIP: no site rows to probe'; return; end if;
  begin
    update public.sites set code = code || 'X' where id = v_id;
  exception when others then
    v_ok := sqlerrm like 'CODE_IMMUTABLE%';
  end;
  if not v_ok then raise exception 'FAIL: sites.code is mutable'; end if;
  raise notice 'PASS: code update rejected';
end $v$;

\echo '== PART 2b: the licence guard rejects invalid and clearing writes (rolled back)'
do $v$
declare v_id uuid; v_bad text; v_ok boolean; v_failed text := '';
begin
  select id into v_id from public.organizations where licence_number is null and status <> 'deactivated' limit 1;
  if v_id is null then raise notice 'SKIP: every company already has a licence number'; return; end if;
  foreach v_bad in array array['APL-12345', 'CLC-9', 'ab', '!!!###$$$ 99', 'NODIGITS'] loop
    v_ok := false;
    begin
      update public.organizations set licence_number = v_bad where id = v_id;
    exception when others then
      v_ok := true;
    end;
    if not v_ok then v_failed := v_failed || v_bad || ' '; end if;
  end loop;
  if v_failed <> '' then raise exception 'FAIL: the licence guard accepted: %', v_failed; end if;
  raise notice 'PASS: all five invalid licence numbers rejected';
end $v$;

\echo '== PART 2c: allocator writes a plain number above 9999 (counter set aside and restored: rolled back)'
do $v$
declare v_code text; v_old integer;
begin
  select last_number into v_old from public.site_code_counters where prefix = 'SINOE';
  insert into public.site_code_counters (prefix, last_number) values ('SINOE', 9998)
    on conflict (prefix) do update set last_number = 9998;
  v_code := public.mg_allocate_site_code('Sinoe');  -- 9999
  v_code := public.mg_allocate_site_code('Sinoe');  -- 10000
  if v_code <> 'MGL-SINOE-10000' then raise exception 'FAIL: expected MGL-SINOE-10000, got %', v_code; end if;
  raise notice 'PASS: allocator crossed 9999 correctly (%)', v_code;
  raise exception 'ROLLBACK_PROBE';  -- never keep the probe's counter change
exception when others then
  if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
end $v$;
