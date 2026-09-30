-- ============================================================================
-- MINEGUARD LIBERIA — migration 0009: normalize public report RPC overloads
--
-- PostgREST reports PGRST203 when an older enum-typed version of this RPC is
-- left beside the current text-typed version. CREATE OR REPLACE does not
-- replace a function when its input argument types change, so remove every
-- overload before recreating the one signature used by the client.
-- ============================================================================

begin;

do $$
declare
  old_rpc record;
begin
  for old_rpc in
    select n.nspname as schema_name,
           p.proname as function_name,
           pg_catalog.oidvectortypes(p.proargtypes) as argument_types
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'submit_community_report'
       and p.prokind = 'f'
  loop
    execute format(
      'drop function %I.%I(%s)',
      old_rpc.schema_name,
      old_rpc.function_name,
      old_rpc.argument_types
    );
  end loop;
end
$$;

create function public.submit_community_report(
  p_tracking_code text,
  p_category      text,
  p_description   text,
  p_county        text,
  p_district      text default null,
  p_community     text default null,
  p_latitude      double precision default null,
  p_longitude     double precision default null,
  p_contact_phone text default null
)
returns jsonb
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_id    uuid;
  v_src   text;
  v_key   text;
  v_count integer;
begin
  v_src := public.mg_client_ip();

  if v_src is null or v_src = '' then
    v_key := 'report:global';
  else
    v_key := 'report:' || encode(
      digest('mgliberia-v1:' || v_src, 'sha256'), 'hex');
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values (v_key, 1, now())
  on conflict (bucket) do update
    set count = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then 1 else public.rate_limits.count + 1 end,
        window_start = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then now() else public.rate_limits.window_start end
  returning count into v_count;

  if v_count > 30 then
    raise exception 'RATE_LIMITED: too many reports submitted from your network right now; try again in a minute';
  end if;

  insert into public.community_reports (
    tracking_code, category, description, county, district, community,
    latitude, longitude, contact_phone
  ) values (
    p_tracking_code, p_category::report_category, p_description, p_county,
    p_district, p_community, p_latitude, p_longitude, p_contact_phone
  )
  returning id into v_id;

  insert into public.report_tracking (tracking_code, status)
  values (p_tracking_code, 'submitted')
  on conflict (tracking_code) do nothing;

  perform public.refresh_public_stats();
  return jsonb_build_object('id', v_id, 'trackingCode', p_tracking_code);
end;
$$;

revoke all on function public.submit_community_report(
  text, text, text, text, text, text, double precision, double precision, text
) from public;
grant execute on function public.submit_community_report(
  text, text, text, text, text, text, double precision, double precision, text
) to anon, authenticated;

notify pgrst, 'reload schema';

commit;