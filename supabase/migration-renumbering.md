# Migration renumbering (2026-11-13)

Two files shared version `0046`. The Supabase CLI keys migration history on the numeric prefix, so it can record only one of
them and `db push` against a fresh database fails on the second. Production's history records
`0046 corrective_action_roles` and nothing after it, so the files below were **unrecorded** and could be renamed without
touching recorded history. Order of application is unchanged.

| Old file | New file |
|---|---|
| 0046_corrective_action_roles | 0046_corrective_action_roles (unchanged, recorded) |
| 0046_worker_voice | 0047_worker_voice |
| 0047_close_admin_bootstrap | 0048_close_admin_bootstrap |
| 0048_public_user_identity | 0049_public_user_identity |
| 0049_public_reports_feedback | 0050_public_reports_feedback |
| 0050_ministry_voice | 0051_ministry_voice |
| 0051_public_content | 0052_public_content |
| 0052_voice_hardening | 0053_voice_hardening |
| 0053_company_supervisor_role | 0054_company_supervisor_role |
| 0054_company_member_discipline | 0055_company_member_discipline |
| 0055_retire_legacy_access_layer (applied by hand 2026-11-13) | 0056_retire_legacy_access_layer |
| 0056_revoke_client_truncate (applied by hand 2026-11-13) | 0057_revoke_client_truncate |

Rollback scripts in `supabase/maintenance/` were renamed to match. Comments and prose inside older files and documents may still
use the former numbers; this table is the authority. The objects of the old 0046–0054 already exist in production (applied by hand),
so the first pipeline run replays 0047–0057 idempotently against them — see docs/db-deployment.md for the rehearsal required first.
