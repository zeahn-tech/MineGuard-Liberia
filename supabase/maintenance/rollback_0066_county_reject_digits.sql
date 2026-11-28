-- ===========================================================================
-- ROLLBACK of migration 0066 (county text containing a digit is refused).
-- Not in supabase/migrations. Restores mg_county_prefix(text) and mg_county_canonical(text) to their 0065 definitions, copied
-- verbatim from supabase/migrations/0065_site_code_hardening.sql (section C); tests/site-code-0066.test.ts proves the match.
-- After this, "Bo1mi" is accepted again and stored as "Bomi".
-- Data-safe: no table, row, counter or setting is touched. Idempotent. Same signatures, security definer and search_path as
-- before; the revokes are re-asserted.
-- Then remove the history row:  delete from supabase_migrations.schema_migrations where version = '0066';
-- Order when rolling back BOTH: run this script first, then rollback_0065_site_code_hardening.sql (which drops these functions).
-- ===========================================================================
begin;

create or replace function public.mg_county_prefix(p_county text)
returns text
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_key text := lower(regexp_replace(coalesce(p_county, ''), '[^A-Za-z]', '', 'g'));
  v_prefix text;
begin
  select prefix into v_prefix from public.county_codes where county_key = v_key;
  if v_prefix is null then
    -- SQLSTATE 22023 (invalid_parameter_value). NOTE: the pre-0065 app does not surface this text — backendError drops the
    -- SQLSTATE and the user sees its generic "We couldn't register the site" message (documented in docs/27, deploy window).
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
  return v_prefix;
end;
$mg$;

-- the county's canonical spelling ("bomi", "Bo-mi!!", " GRAND   bassa" -> "Bomi", "Bomi", "Grand Bassa"); raises INVALID_COUNTY
create or replace function public.mg_county_canonical(p_county text)
returns text
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_name text;
begin
  select county into v_name from public.county_codes
   where county_key = lower(regexp_replace(coalesce(p_county, ''), '[^A-Za-z]', '', 'g'));
  if v_name is null then
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
  return v_name;
end;
$mg$;

revoke all on function public.mg_county_prefix(text) from public, anon, authenticated;
revoke all on function public.mg_county_canonical(text) from public, anon, authenticated;

commit;
