-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0020: AI request log
-- (Session 8: AI-1 — AI assistance per docs/08_AI_GOVERNANCE.MD)
--
-- Every request to the `ai-assist` Edge Function leaves exactly one row here,
-- whatever the outcome (answered, abstained, refused, error). The log exists
-- so a reviewer can answer "who asked the AI assistant for what, in which
-- mode, and what came back" without the platform keeping the question text:
--
--   * the request is recorded as a SHA-256 hash + length (a free-text question
--     can contain names or phone numbers; the hash proves identity of a
--     repeated query without storing it);
--   * the STRUCTURED filters a search was translated into are stored in full —
--     they are validated against an allowlist before they are run, so they
--     are safe to keep and are what actually touched the data;
--   * counts of retrieved records and of citations (and how many a
--     cite-or-abstain check DROPPED) are stored, never the records.
--
-- Properties (tested in tests/ai-assist.test.ts and tests/migration-apply.test.ts):
--   * append-only — no UPDATE / DELETE for anyone (trigger blocks the owner too);
--   * user_id is server-assigned from the session, never client-supplied;
--   * any signed-in account may INSERT (so a REFUSED request from a role-less
--     account is logged too) — the guard attributes the row to the session;
--     accounts READ their own rows; administrators read all rows;
--   * the table holds no record content and no prompt/response text.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

begin;

create table if not exists public.ai_request_log (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id),
  capability         text not null check (capability in (
                       'nl_search', 'site_summary', 'trend_notes',
                       'inspection_priorities', 'executive_briefing',
                       'document_analysis')),
  -- 'deterministic' = no model was called (the only mode until the owner
  -- approves a provider); 'provider' = a model produced or shaped the output.
  mode               text not null check (mode in ('deterministic', 'provider')),
  provider_id        text check (provider_id is null or length(provider_id) <= 64),
  outcome            text not null check (outcome in (
                       'answered', 'abstained', 'refused', 'error')),
  query_sha256       text check (query_sha256 is null or query_sha256 ~ '^[0-9a-f]{64}$'),
  query_length       integer check (query_length is null or query_length >= 0),
  filters            jsonb,
  record_count       integer not null default 0 check (record_count >= 0),
  citation_count     integer not null default 0 check (citation_count >= 0),
  dropped_citations  integer not null default 0 check (dropped_citations >= 0),
  injection_flagged  boolean not null default false,
  error_code         text check (error_code is null or length(error_code) <= 64),
  latency_ms         integer check (latency_ms is null or latency_ms >= 0),
  created_at         timestamptz not null default now()
);

create index if not exists ai_request_log_user_created_idx
  on public.ai_request_log (user_id, created_at desc);
create index if not exists ai_request_log_created_idx
  on public.ai_request_log (created_at desc);

-- Server-owned columns + immutability. With a session, the row is ALWAYS
-- attributed to the session's account (a client cannot log as someone else);
-- a null uid is the migration owner / service role (keeps the supplied id).
create or replace function public.mg_ai_request_log_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $mg$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'IMMUTABLE: the AI request log is append-only';
  end if;
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  new.id         := coalesce(new.id, gen_random_uuid());
  new.created_at := now();
  return new;
end
$mg$;

drop trigger if exists ai_request_log_guard on public.ai_request_log;
create trigger ai_request_log_guard
  before insert or update or delete on public.ai_request_log
  for each row execute function public.mg_ai_request_log_guard();

alter table public.ai_request_log enable row level security;

drop policy if exists "ai log insert own" on public.ai_request_log;
create policy "ai log insert own" on public.ai_request_log
  for insert to authenticated
  with check (auth.uid() is not null);

drop policy if exists "ai log read own or admin" on public.ai_request_log;
create policy "ai log read own or admin" on public.ai_request_log
  for select to authenticated
  using (user_id = auth.uid() or public.mg_is_admin());

revoke all on public.ai_request_log from anon, authenticated, public;
grant select, insert on public.ai_request_log to authenticated;

-- Guard is a trigger internal: no client role may execute it directly.
revoke execute on function public.mg_ai_request_log_guard() from public, anon, authenticated;

commit;
