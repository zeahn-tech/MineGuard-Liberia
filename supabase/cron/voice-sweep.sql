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
        url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/worker-voice-push',
        headers := jsonb_build_object('Content-Type','application/json','x-sweep-secret','<WORKER_VOICE_PUSH_SECRET>'),
        body    := '{}'::jsonb,
        timeout_milliseconds := 20000) $$);

 Stop it:  select cron.unschedule('mineguard-voice-sweep');
 The secret is stored in cron.job: treat that table as sensitive and rotate the secret if it is exposed.
