-- Small deterministic fixture for scripts/restore-drill-local.sh.
-- Inserted as the superuser; guard triggers that need a JWT are bypassed via
-- session_replication_role where necessary.
set session_replication_role = replica;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'admin@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'inspector@example.test');
insert into public.profiles (id, email, name, role, scope, profile_complete) values
  ('00000000-0000-4000-8000-000000000001', 'admin@example.test', 'Drill Admin', 'admin', 'national', true),
  ('00000000-0000-4000-8000-000000000002', 'inspector@example.test', 'Drill Inspector', 'inspector', 'county', true);
insert into public.sites (id, code, name, operator_name, county, status, created_by) values
  ('11111111-1111-4111-8111-111111111111', 'DR-001', 'Drill Site A', 'Drill Operator', 'Bomi', 'active', '00000000-0000-4000-8000-000000000001'),
  ('11111111-1111-4111-8111-111111111112', 'DR-002', 'Drill Site B', 'Drill Operator', 'Nimba', 'active', '00000000-0000-4000-8000-000000000001');
insert into public.inspection_templates (id, name, created_by) values
  ('33333333-3333-4333-8333-333333333333', 'Drill template', '00000000-0000-4000-8000-000000000001');
insert into public.inspections (site_id, template_id, inspector_id, status, client_ref) values
  ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '00000000-0000-4000-8000-000000000002', 'draft', 'drill-ref-1');
insert into public.community_reports (tracking_code, category, description, county) values
  ('MG-DRILL-0001', 'pollution', 'Drill report', 'Bomi');
insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary) values
  ('00000000-0000-4000-8000-000000000001', 'Drill Admin', 'drill', 'site', '11111111-1111-4111-8111-111111111111', 'fixture row');
set session_replication_role = origin;
