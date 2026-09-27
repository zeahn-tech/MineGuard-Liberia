-- ============================================================================
-- MINEGUARD LIBERIA — migration 0008: template DELETE policy completion
--
-- Found by the template-editor suite (§11, tests/template-editor.test.ts):
-- mg_guard_template_write() carries an explicit admin-only DELETE branch
-- (intent: administrators may delete templates), and the data layer exposes
-- deleteTemplate(), but 0001 defined NO "templates delete" RLS policy. Under
-- RLS, rows invisible to a DELETE are silently skipped — Postgres deletes
-- zero rows WITHOUT error (the BEFORE DELETE guard never even fires, because
-- triggers run only on rows that pass the policy filter). The result: admin
-- template deletion silently did nothing, on every lineage with this schema.
--
-- Fix: the missing policy, admin-only. Deletion of in-use templates is still
-- refused — by the data layer (TEMPLATE_IN_USE check), which is where the
-- referential question is answerable, and by audit logging on success.
--
-- Verified by test: admin delete removes an unreferenced template (row gone,
-- audit row written); delete of a template referenced by inspections is
-- refused with TEMPLATE_IN_USE; non-admin delete remains FORBIDDEN.
-- ============================================================================

create policy "templates delete" on public.inspection_templates
  for delete using (public.mg_is_admin());
