-- ===========================================================================
-- ROLLBACK of migration 0051 (approved public content).
-- LOSES all public_content rows and their review history (drafts, approvals, published content).
-- Export first if they matter:  select * from public.public_content;  select * from public.public_content_events;
-- It also RESTORES the anonymous live statistics (meta readable by everyone) — re-opening the
-- exposure of all-company incident/inspection counts. Not in supabase/migrations. Run before
-- rolling back 0049, never after.
-- ===========================================================================
begin;

drop function if exists public.mg_content_get(uuid);
drop function if exists public.mg_content_list(text, text, integer);
drop function if exists public.mg_content_revise(uuid);
drop function if exists public.mg_content_transition(uuid, text, text, jsonb);
drop function if exists public.mg_content_save(uuid, text, text, text, text, text, text, jsonb, timestamptz, timestamptz, text, text);
drop function if exists public.mg_content_validate(text, text, text, jsonb);
drop function if exists public.mg_content_can_view();
drop table if exists public.public_content_events;
drop table if exists public.public_content;
drop function if exists public.mg_content_guard();

delete from public.permissions
 where permission in ('content.author', 'content.review', 'content.publish');

drop policy if exists "meta staff read" on public.meta;
create policy "meta public read" on public.meta for select using (true);
grant select on public.meta to anon;

commit;
