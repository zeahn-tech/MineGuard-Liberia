-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0042: AI incident insights (Implementation Phase 3)
--
-- The `ai-assist` Edge Function gains two deterministic capabilities,
-- `incident_trend_summary` and `risk_patterns`. Every request is logged in
-- ai_request_log (0020), whose capability CHECK must therefore admit them.
-- That is the ONLY schema change: no new table, no new function, no new
-- grant, no new policy. The log remains append-only and holds hashes, counts
-- and validated filters — never prompt or response text.
--
-- The per-user hourly rate limit reads this same table under the caller's own
-- RLS ("ai log read own or admin"), so it needs no new surface either.
--
-- ROLLBACK: re-run the 0020 definition of the constraint (six capabilities).
-- Rows already written with the new names would block that; delete them is not
-- possible (append-only), so roll back the CODE first and leave this constraint
-- in place — it is harmless without the code.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

begin;

alter table public.ai_request_log
  drop constraint if exists ai_request_log_capability_check;

alter table public.ai_request_log
  add constraint ai_request_log_capability_check check (capability in (
    'nl_search', 'site_summary', 'trend_notes',
    'inspection_priorities', 'executive_briefing',
    'document_analysis',
    'incident_trend_summary', 'risk_patterns'));

commit;
