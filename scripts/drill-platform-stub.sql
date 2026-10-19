
-- ---- roles Supabase provisions by default ---------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- ---- auth schema ----------------------------------------------------------
create schema auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- PostgREST puts the JWT claims into this GUC; our stub reads it the same way.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'anon')
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb,
                  '{}'::jsonb)
$$;

-- GoTrue MFA stub (Gap #4): the two tables the client-side MFA lifecycle
-- needs. Secrets are stored in PLAINTEXT here — the real GoTrue encrypts
-- them; this stub exists to prove the CLIENT contract, not GoTrue's.
create table auth.mfa_factors (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type   text not null default 'totp',
  secret        text not null,
  status        text not null default 'unverified' check (status in ('unverified','verified')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table auth.mfa_challenges (
  id            uuid primary key default gen_random_uuid(),
  factor_id     uuid not null references auth.mfa_factors(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  verified_at   timestamptz,
  created_at    timestamptz not null default now()
);

grant usage on schema auth to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;

-- ---- storage schema -------------------------------------------------------
create schema storage;

create table storage.buckets (
  id              text primary key,
  name            text,
  public          boolean not null default false,
  file_size_limit bigint
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

-- Hosted Supabase has RLS ON for storage.objects; the only policies that may
-- exist are the ones our own migrations create.
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : cardinality(string_to_array(name, '/')) - 1]
$$;

grant usage on schema storage to anon, authenticated;
grant execute on all functions in schema storage to anon, authenticated;
grant select, insert, update, delete on storage.buckets, storage.objects
  to anon, authenticated;

-- ---- realtime publication -------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
