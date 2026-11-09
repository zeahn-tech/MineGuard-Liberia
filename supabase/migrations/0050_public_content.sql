-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0050: approved public content
--                                     (Public User programme, Phase D)
--
-- GOAL. The public may read ONLY content the Ministry explicitly approved and published.
-- Nothing is public merely because it exists in the app, an API or the frontend.
--
-- WHAT THIS ADDS
--   A. permissions content.author / content.review / content.publish (existing permissions
--      table): authors and reviewers are administrators and supervisors, publishers are
--      administrators only.
--   B. public_content (glossary terms, safety guidance, announcements, approved statistics) with
--      the lifecycle draft -> pending_review -> approved -> published -> archived, and
--      public_content_events (staff-only history of every step, with the reviewer's checks).
--   C. Read access: anyone (no session needed) may read PUBLISHED, in-date rows and only the
--      public columns (column grants — provenance notes and staff identifiers are not
--      readable by any client). No client has any write grant: every write and every staff read
--      goes through the functions below, each checking its permission.
--   D. Lifecycle rules enforced in the database:
--        - only drafts are editable; approved/published/archived content is immutable
--          (a change is a new revision, which archives the old version when published);
--        - a reviewer can never approve content they wrote or last edited (four-eyes);
--        - approval needs a written note and the reviewer's confirmation of accuracy,
--          completeness and confidentiality;
--        - only the publish permission publishes or archives.
--   E. The live anonymous statistics are retired: meta (public_stats) is no longer readable by
--      anon (nor by non-staff). Public figures are now human-approved 'statistics' snapshots.
--
-- Nothing is published by this migration. The existing glossary is prepared as DRAFTS by the
-- separate, explicit seed supabase/seeds/public_glossary_drafts.sql (not a migration).
--
-- Idempotent. ROLLBACK: supabase/maintenance/rollback_0050_public_content.sql
-- ===========================================================================

begin;

-- A. permissions --------------------------------------------------------------------------
insert into public.permissions (role, permission) values
  ('admin',      'content.author'),
  ('supervisor', 'content.author'),
  ('admin',      'content.review'),
  ('supervisor', 'content.review'),
  ('admin',      'content.publish')
on conflict do nothing;

-- B. tables -------------------------------------------------------------------------------
create table if not exists public.public_content (
  id             uuid primary key default gen_random_uuid(),
  content_key    uuid not null default gen_random_uuid(),   -- stable across revisions
  kind           text not null check (kind in ('glossary_term', 'safety_guidance', 'announcement', 'statistics')),
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$'),
  language       text not null default 'en' check (language in ('en', 'fr')),
  title          text not null check (char_length(title) between 2 and 150),
  summary        text check (summary is null or char_length(summary) <= 300),
  body           text not null default '' check (char_length(body) <= 20000),
  category       text check (category is null or char_length(category) <= 80),
  data           jsonb,                                       -- statistics items only
  status         text not null default 'draft'
                   check (status in ('draft', 'pending_review', 'approved', 'published', 'archived')),
  version        integer not null default 1,
  supersedes     uuid references public.public_content(id),
  translation_of uuid references public.public_content(id),
  source         text check (source is null or char_length(source) <= 300),  -- provenance; staff only
  author_id      uuid references public.profiles(id),                         -- staff only
  edited_by      uuid references public.profiles(id),                         -- staff only
  publish_at     timestamptz,
  expires_at     timestamptz,
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  updated_by     uuid,
  row_version    integer not null default 1,
  unique (kind, slug, language, version)
);
create unique index if not exists public_content_one_published
  on public.public_content (kind, slug, language) where status = 'published';
create index if not exists public_content_status_idx on public.public_content (status, kind);
create index if not exists public_content_key_idx on public.public_content (content_key);

create table if not exists public.public_content_events (
  id          uuid primary key default gen_random_uuid(),
  content_id  uuid not null references public.public_content(id),
  action      text not null check (action in ('create', 'edit', 'submit', 'return', 'approve', 'publish', 'archive', 'revise', 'import')),
  from_status text,
  to_status   text,
  actor_id    uuid references public.profiles(id),            -- null = system import
  note        text check (note is null or char_length(note) <= 1000),
  checks      jsonb,
  created_at  timestamptz not null default clock_timestamp()  -- real time, so steps in one transaction keep their order
);
create index if not exists public_content_events_idx on public.public_content_events (content_id, created_at);

drop trigger if exists public_content_touch on public.public_content;
create trigger public_content_touch before insert or update on public.public_content
  for each row execute function public.mg_touch_row();
drop trigger if exists public_content_audit on public.public_content;
create trigger public_content_audit after insert or update on public.public_content
  for each row execute function public.mg_audit_row();

-- C. read access: published + in date, public columns only; no client writes ---------------
alter table public.public_content enable row level security;
alter table public.public_content_events enable row level security;
revoke all on public.public_content from public, anon, authenticated;
revoke all on public.public_content_events from public, anon, authenticated;

grant select (id, kind, slug, language, title, summary, body, category, data, version, published_at)
  on public.public_content to anon, authenticated;

drop policy if exists "published content is public" on public.public_content;
create policy "published content is public" on public.public_content
  for select to anon, authenticated
  using (status = 'published'
         and (publish_at is null or publish_at <= now())
         and (expires_at is null or expires_at > now()));

-- D. lifecycle guard (belt: only definer functions can write at all) -------------------------
create or replace function public.mg_content_guard()
returns trigger
language plpgsql security invoker set search_path = public
as $mg$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft'
     and ( new.kind is distinct from old.kind
        or new.slug is distinct from old.slug
        or new.language is distinct from old.language
        or new.title is distinct from old.title
        or new.summary is distinct from old.summary
        or new.body is distinct from old.body
        or new.category is distinct from old.category
        or new.data is distinct from old.data
        or new.publish_at is distinct from old.publish_at
        or new.expires_at is distinct from old.expires_at
        or new.version is distinct from old.version
        or new.content_key is distinct from old.content_key) then
    raise exception 'IMMUTABLE: only drafts can be edited; make a revision instead';
  end if;
  return new;
end;
$mg$;
drop trigger if exists public_content_guard on public.public_content;
create trigger public_content_guard before update on public.public_content
  for each row execute function public.mg_content_guard();

create or replace function public.mg_content_can_view()
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select auth.uid() is not null
     and (public.mg_has_permission('content.author')
          or public.mg_has_permission('content.review')
          or public.mg_has_permission('content.publish'))
$mg$;

-- validation shared by create/edit ------------------------------------------------------------
create or replace function public.mg_content_validate(
  p_kind text, p_body text, p_category text, p_data jsonb)
returns void
language plpgsql immutable set search_path = public
as $mg$
declare
  v_item jsonb;
  v_n    integer;
begin
  if p_kind = 'statistics' then
    if p_data is null or jsonb_typeof(p_data -> 'items') <> 'array' then
      raise exception 'INVALID_INPUT: statistics need a list of figures';
    end if;
    v_n := jsonb_array_length(p_data -> 'items');
    if v_n < 1 or v_n > 12 then
      raise exception 'INVALID_INPUT: a statistics set holds 1 to 12 figures';
    end if;
    for v_item in select * from jsonb_array_elements(p_data -> 'items') loop
      if jsonb_typeof(v_item -> 'label') <> 'string'
         or char_length(v_item ->> 'label') not between 2 and 80 then
        raise exception 'INVALID_INPUT: each figure needs a label of 2 to 80 characters';
      end if;
      if jsonb_typeof(v_item -> 'value') <> 'number'
         or (v_item ->> 'value')::numeric < 0 or (v_item ->> 'value')::numeric > 1000000000000 then
        raise exception 'INVALID_INPUT: each figure needs a number between 0 and 1,000,000,000,000';
      end if;
      if coalesce(v_item ->> 'as_of', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'INVALID_INPUT: each figure needs an as-of date (YYYY-MM-DD)';
      end if;
      begin
        perform (v_item ->> 'as_of')::date;
      exception when others then
        raise exception 'INVALID_INPUT: each figure needs an as-of date (YYYY-MM-DD)';
      end;
    end loop;
  else
    if p_data is not null then
      raise exception 'INVALID_INPUT: only statistics carry figures';
    end if;
    if p_kind = 'glossary_term' and (char_length(coalesce(p_body, '')) < 10 or p_category is null) then
      raise exception 'INVALID_INPUT: a glossary term needs a definition (10+ characters) and a category';
    end if;
    if p_kind = 'safety_guidance' and char_length(coalesce(p_body, '')) < 20 then
      raise exception 'INVALID_INPUT: safety guidance needs at least 20 characters of text';
    end if;
    if p_kind = 'announcement' and char_length(coalesce(p_body, '')) < 10 then
      raise exception 'INVALID_INPUT: an announcement needs at least 10 characters of text';
    end if;
  end if;
end;
$mg$;

-- create / edit a DRAFT --------------------------------------------------------------------
create or replace function public.mg_content_save(
  p_id         uuid,
  p_kind       text,
  p_slug       text,
  p_title      text,
  p_summary    text default null,
  p_body       text default '',
  p_category   text default null,
  p_data       jsonb default null,
  p_publish_at timestamptz default null,
  p_expires_at timestamptz default null,
  p_language   text default 'en',
  p_source     text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_uid  uuid := auth.uid();
  v_old  public.public_content%rowtype;
  v_id   uuid;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
begin
  if v_uid is null or not public.mg_has_permission('content.author') then
    raise exception 'FORBIDDEN: content author permission required';
  end if;
  if p_expires_at is not null and p_publish_at is not null and p_expires_at <= p_publish_at then
    raise exception 'INVALID_INPUT: the expiry must be after the publish date';
  end if;
  perform public.mg_content_validate(p_kind, p_body, p_category, p_data);

  if p_id is null then
    insert into public.public_content (kind, slug, language, title, summary, body, category, data,
                                       publish_at, expires_at, source, author_id, edited_by)
    values (p_kind, v_slug, coalesce(p_language, 'en'), btrim(p_title), nullif(btrim(coalesce(p_summary, '')), ''),
            coalesce(p_body, ''), nullif(btrim(coalesce(p_category, '')), ''), p_data,
            p_publish_at, p_expires_at, nullif(btrim(coalesce(p_source, '')), ''), v_uid, v_uid)
    returning id into v_id;
    insert into public.public_content_events (content_id, action, to_status, actor_id)
    values (v_id, 'create', 'draft', v_uid);
    return v_id;
  end if;

  select * into v_old from public.public_content where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: no such content';
  end if;
  if v_old.status <> 'draft' then
    raise exception 'IMMUTABLE: only drafts can be edited; make a revision instead';
  end if;
  if v_old.kind <> p_kind then
    raise exception 'INVALID_INPUT: the kind of a draft cannot be changed';
  end if;

  update public.public_content
     set slug = v_slug, language = coalesce(p_language, language), title = btrim(p_title),
         summary = nullif(btrim(coalesce(p_summary, '')), ''), body = coalesce(p_body, ''),
         category = nullif(btrim(coalesce(p_category, '')), ''), data = p_data,
         publish_at = p_publish_at, expires_at = p_expires_at,
         source = coalesce(nullif(btrim(coalesce(p_source, '')), ''), source),
         edited_by = v_uid
   where id = p_id;
  insert into public.public_content_events (content_id, action, from_status, to_status, actor_id)
  values (p_id, 'edit', 'draft', 'draft', v_uid);
  return p_id;
end;
$mg$;

-- lifecycle transitions -----------------------------------------------------------------------
create or replace function public.mg_content_transition(
  p_id     uuid,
  p_to     text,
  p_note   text default null,
  p_checks jsonb default null
)
returns void
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_uid  uuid := auth.uid();
  v_row  public.public_content%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_act  text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  select * into v_row from public.public_content where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: no such content';
  end if;

  if v_row.status = 'draft' and p_to = 'pending_review' then
    if not public.mg_has_permission('content.author') then
      raise exception 'FORBIDDEN: content author permission required';
    end if;
    perform public.mg_content_validate(v_row.kind, v_row.body, v_row.category, v_row.data);
    v_act := 'submit';

  elsif v_row.status in ('pending_review', 'approved') and p_to = 'draft' then
    if not (public.mg_has_permission('content.review') or public.mg_has_permission('content.publish')) then
      raise exception 'FORBIDDEN: reviewer or publisher permission required';
    end if;
    if v_note is null or char_length(v_note) < 10 then
      raise exception 'INVALID_INPUT: say why it goes back (at least 10 characters)';
    end if;
    v_act := 'return';

  elsif v_row.status = 'pending_review' and p_to = 'approved' then
    if not public.mg_has_permission('content.review') then
      raise exception 'FORBIDDEN: content reviewer permission required';
    end if;
    if v_uid = v_row.author_id or v_uid = v_row.edited_by then
      raise exception 'FORBIDDEN: you cannot approve content you wrote or last edited';
    end if;
    if v_note is null or char_length(v_note) < 10 then
      raise exception 'INVALID_INPUT: record what you reviewed (at least 10 characters)';
    end if;
    if p_checks is null
       or coalesce((p_checks ->> 'accuracy')::boolean, false) is not true
       or coalesce((p_checks ->> 'completeness')::boolean, false) is not true
       or coalesce((p_checks ->> 'confidentiality')::boolean, false) is not true then
      raise exception 'INVALID_INPUT: confirm accuracy, completeness and confidentiality';
    end if;
    v_act := 'approve';

  elsif v_row.status = 'approved' and p_to = 'published' then
    if not public.mg_has_permission('content.publish') then
      raise exception 'FORBIDDEN: content publisher permission required';
    end if;
    -- a new version retires the version it replaces
    update public.public_content
       set status = 'archived'
     where kind = v_row.kind and slug = v_row.slug and language = v_row.language
       and status = 'published' and id <> v_row.id;
    v_act := 'publish';

  elsif v_row.status = 'published' and p_to = 'archived' then
    if not public.mg_has_permission('content.publish') then
      raise exception 'FORBIDDEN: content publisher permission required';
    end if;
    if v_note is null or char_length(v_note) < 10 then
      raise exception 'INVALID_INPUT: say why it is withdrawn (at least 10 characters)';
    end if;
    v_act := 'archive';

  else
    raise exception 'INVALID_TRANSITION: % cannot move to %', v_row.status, p_to;
  end if;

  update public.public_content
     set status = p_to,
         published_at = case when p_to = 'published' then now() else published_at end
   where id = p_id;
  insert into public.public_content_events (content_id, action, from_status, to_status, actor_id, note, checks)
  values (p_id, v_act, v_row.status, p_to, v_uid, v_note, case when v_act = 'approve' then p_checks end);
end;
$mg$;

-- a new draft revision of published or archived content ---------------------------------------
create or replace function public.mg_content_revise(p_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_uid uuid := auth.uid();
  v_row public.public_content%rowtype;
  v_new uuid;
begin
  if v_uid is null or not public.mg_has_permission('content.author') then
    raise exception 'FORBIDDEN: content author permission required';
  end if;
  select * into v_row from public.public_content where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: no such content';
  end if;
  if v_row.status not in ('published', 'archived') then
    raise exception 'INVALID_TRANSITION: only published or archived content can be revised';
  end if;
  if exists (select 1 from public.public_content c
              where c.content_key = v_row.content_key and c.status in ('draft', 'pending_review', 'approved')) then
    raise exception 'INVALID_TRANSITION: a revision is already in progress';
  end if;

  insert into public.public_content (content_key, kind, slug, language, title, summary, body, category, data,
                                     version, supersedes, source, author_id, edited_by)
  values (v_row.content_key, v_row.kind, v_row.slug, v_row.language, v_row.title, v_row.summary, v_row.body,
          v_row.category, v_row.data,
          (select max(version) + 1 from public.public_content where content_key = v_row.content_key),
          v_row.id, v_row.source, v_uid, v_uid)
  returning id into v_new;
  insert into public.public_content_events (content_id, action, to_status, actor_id, note)
  values (v_new, 'revise', 'draft', v_uid, 'Revision of version ' || v_row.version);
  return v_new;
end;
$mg$;

-- staff reads ------------------------------------------------------------------------------------
create or replace function public.mg_content_list(
  p_status text default null, p_kind text default null, p_limit integer default 200)
returns table (
  id uuid, kind text, slug text, language text, title text, summary text, category text,
  status text, version integer, author_name text, edited_by_name text, source text,
  publish_at timestamptz, expires_at timestamptz, published_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_content_can_view() then
    raise exception 'FORBIDDEN: content permission required';
  end if;
  return query
    select c.id, c.kind, c.slug, c.language, c.title, c.summary, c.category, c.status, c.version,
           pa.name, pe.name, c.source, c.publish_at, c.expires_at, c.published_at, c.created_at, c.updated_at
      from public.public_content c
      left join public.profiles pa on pa.id = c.author_id
      left join public.profiles pe on pe.id = c.edited_by
     where (p_status is null or c.status = p_status)
       and (p_kind is null or c.kind = p_kind)
     order by case c.status when 'pending_review' then 0 when 'approved' then 1 when 'draft' then 2
                            when 'published' then 3 else 4 end,
              c.kind, c.title
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$mg$;

create or replace function public.mg_content_get(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_row public.public_content%rowtype;
begin
  if auth.uid() is null or not public.mg_content_can_view() then
    raise exception 'FORBIDDEN: content permission required';
  end if;
  select * into v_row from public.public_content where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: no such content';
  end if;
  return jsonb_build_object(
    'id', v_row.id, 'kind', v_row.kind, 'slug', v_row.slug, 'language', v_row.language,
    'title', v_row.title, 'summary', v_row.summary, 'body', v_row.body, 'category', v_row.category,
    'data', v_row.data, 'status', v_row.status, 'version', v_row.version, 'source', v_row.source,
    'publishAt', v_row.publish_at, 'expiresAt', v_row.expires_at, 'publishedAt', v_row.published_at,
    'authorId', v_row.author_id, 'editedBy', v_row.edited_by,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'action', e.action, 'from', e.from_status, 'to', e.to_status, 'note', e.note,
               'checks', e.checks, 'at', e.created_at, 'actor', coalesce(p.name, 'System import'))
             order by e.created_at)
        from public.public_content_events e
        left join public.profiles p on p.id = e.actor_id
       where e.content_id = v_row.id), '[]'::jsonb));
end;
$mg$;

revoke all on function public.mg_content_can_view() from public, anon;
revoke all on function public.mg_content_save(uuid, text, text, text, text, text, text, jsonb, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.mg_content_transition(uuid, text, text, jsonb) from public, anon;
revoke all on function public.mg_content_revise(uuid) from public, anon;
revoke all on function public.mg_content_list(text, text, integer) from public, anon;
revoke all on function public.mg_content_get(uuid) from public, anon;
revoke all on function public.mg_content_validate(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mg_content_can_view() to authenticated;
grant execute on function public.mg_content_save(uuid, text, text, text, text, text, text, jsonb, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.mg_content_transition(uuid, text, text, jsonb) to authenticated;
grant execute on function public.mg_content_revise(uuid) to authenticated;
grant execute on function public.mg_content_list(text, text, integer) to authenticated;
grant execute on function public.mg_content_get(uuid) to authenticated;

-- E. retire the live anonymous statistics -----------------------------------------------------
-- meta held only public_stats: live, all-company counts of sites, inspections, incidents and
-- reports that anyone could read without signing in. Public figures are now approved
-- 'statistics' content. Staff keep read access; the recompute function is unchanged.
revoke select on public.meta from anon;
drop policy if exists "meta public read" on public.meta;
drop policy if exists "meta staff read" on public.meta;
create policy "meta staff read" on public.meta
  for select to authenticated using (public.mg_is_staff());

commit;
