-- ============================================================================
-- MINEGUARD LIBERIA — migration 0066: county text containing a digit is refused (audit finding N-1)
--
-- WHY. 0065 matched a county on its LETTERS only ('[^A-Za-z]' stripped), so "Bo1mi" was accepted and stored as "Bomi".
-- A digit is never part of an official county name, so it is almost certainly a typo (or a probe): it is now refused.
--
-- WHAT. mg_county_prefix(text) and mg_county_canonical(text) are replaced (same signatures, same security definer, same
-- search_path, same grants). County text containing a digit raises INVALID_COUNTY with SQLSTATE 22023, exactly like any other
-- non-county. Spaces, hyphens and other punctuation are still ignored ("Bo-mi!!" and " GRAND   bassa" stay valid).
-- Everything that resolves a county goes through these two functions: the sites insert trigger, a county change on a site,
-- mg_allocate_site_code and mg_request_site (company site requests).
--
-- NOT CHANGED. No table, row, counter, setting or trigger is touched; no data is rewritten. Legacy rows keep whatever county
-- spelling they have (the sites trigger only resolves a county when a row is INSERTED or its county is CHANGED, so an old row
-- whose county happens to contain a digit keeps working until someone edits that county). Worker Voice / Ministry Voice site
-- codes and CR- tracking codes are untouched. Do not edit 0065 (applied): this file supersedes only the two functions.
--
-- Idempotent (create or replace + re-asserted grants), one transaction.
-- Rollback: supabase/maintenance/rollback_0066_county_reject_digits.sql (restores the 0065 versions verbatim).
-- ============================================================================
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
  -- 0066: a digit is never part of a county name. Refuse instead of silently dropping it.
  if coalesce(p_county, '') ~ '[0-9[:digit:]]' then
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia (a county name contains no digits)', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
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

-- the county's canonical spelling ("bomi", "Bo-mi!!", " GRAND   bassa" -> "Bomi", "Bomi", "Grand Bassa"); raises INVALID_COUNTY,
-- including for any text that contains a digit ("Bo1mi")
create or replace function public.mg_county_canonical(p_county text)
returns text
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_name text;
begin
  -- 0066: a digit is never part of a county name. Refuse instead of silently dropping it.
  if coalesce(p_county, '') ~ '[0-9[:digit:]]' then
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia (a county name contains no digits)', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
  select county into v_name from public.county_codes
   where county_key = lower(regexp_replace(coalesce(p_county, ''), '[^A-Za-z]', '', 'g'));
  if v_name is null then
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
  return v_name;
end;
$mg$;

-- grants: internal helpers, never reachable by a client role (re-asserted, same as 0065 section G)
revoke all on function public.mg_county_prefix(text) from public, anon, authenticated;
revoke all on function public.mg_county_canonical(text) from public, anon, authenticated;

commit;
