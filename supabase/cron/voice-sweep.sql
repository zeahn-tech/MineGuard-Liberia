 OPTIONAL scheduler for Worker Voice push and ageing (not applied by migrations).
 Without it: in-app notifications and the bell still work; device push, daily reminders and the automatic
 escalation of unacknowledged company reports (after 7 days) do not run.
 Requires pg_cron + pg_net (Supabase: Database -> Extensions) and the edge function secret WORKER_VOICE_PUSH_SECRET.
 Replace the two placeholders, then run once in the SQL editor. Every minute it delivers queued pushes (fixed generic
 payloads) and runs the ageing sweep (once-a-day reminders; 7-day escalation).

 select cron.schedule(
   'mineguard-voice-sweep',
   '* * * * *',
   $$ select net.http_post(
        url     := 'https://ewukneoblhogtreeekqc.supabase.co/functions/v1/worker-voice-push',
        headers := jsonb_build_object('Content-Type','application/json','x-sweep-secret','a8f3c91e7d42b650f1a9e83c6d5b0274e9f18a3c7b62d0e5f4a91c8b3d76e2059a1f4c8e7b32d6a0f9e51c4b8d27a603e6f19a5c2b84d7e0f3a96c1b5d28e47'),
        body    := '{}'::jsonb,
        timeout_milliseconds := 20000) $$);

 Stop it:  select cron.unschedule('mineguard-voice-sweep');
 The secret is stored in cron.job: treat that table as sensitive and rotate the secret if it is exposed.
