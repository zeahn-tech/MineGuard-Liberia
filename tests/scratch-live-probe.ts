// Throwaway diagnostic probe #4 (delete after use). Reproduces the exact
// PostgREST invocation of complete_staff_profile as the real user, inside a
// transaction that always rolls back — no data is changed.
const TOKEN = "sbp_fcd73947857f1d22e79196e659c1e4c3e8150326";
const REF = "ewukneoblhogtreeekqc";
const UID = "a82c1edf-8e3b-4cc9-9c36-ee85a9dd2a15"; // the one real profile

async function q(label: string, sql: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  console.log(`--- ${label} ---`);
  console.log(res.status, body.slice(0, 1600));
}

// 1. The full PostgREST-equivalent invocation, rolled back.
await q(
  "simulated RPC call (rolled back)",
  `begin;
     set local role authenticated;
     set local request.jwt.claims = '{"sub":"${UID}","role":"authenticated"}';
     select public.complete_staff_profile('Field Officer','MineGuard Program','national',null,null) as result;
   rollback;`,
);

// 2. Each internal step, to isolate a failure if the call errors.
await q(
  "step: auth.uid() under claims GUC",
  `begin;
     set local role authenticated;
     set local request.jwt.claims = '{"sub":"${UID}","role":"authenticated"}';
     select auth.uid() as uid;
   rollback;`,
);

await q(
  "step: guest check subquery",
  `select exists (select 1 from auth.users u where u.id = '${UID}' and u.is_anonymous) as is_guest;`,
);

await q(
  "step: guard trigger would allow the update? (definer context = postgres)",
  `select current_user <> 'authenticated' as guard_passes_because_definer;`,
);
