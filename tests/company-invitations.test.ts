// ---------------------------------------------------------------------------
// Phase B — company lifecycle + company-administrator invitations (0025).
// Every session rolls back (withRole/asUser), so cases are independent.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asUser, getDb, getFixture, withRole } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const RIVAL = "aaaaaaaa-0000-4000-8000-0000000000f1";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql",
    "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql",
    "0027_site_scoped_access.sql",
    "0028_account_names_invitation_cleanup.sql", "0029_onboarding_officer_bulk_import.sql",
  ]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", m), "utf8"));
  }
});

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

/** Run as postgres: seed a fresh invitee account (rolled back with the session). */
async function newUser(run: (s: string) => Promise<unknown[]>, id: string, email: string, confirmed = true) {
  await run(
    `insert into auth.users (id, email, email_confirmed_at) values ('${id}', '${email}', ${confirmed ? "now()" : "null"})`,
  );
}

const asPostgres = <T>(fn: (run: (s: string) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
  withRole("postgres", null, fn);

async function adminFlow(run: (s: string) => Promise<Record<string, unknown>[]>) {
  const org = (await run("select public.mg_register_company('Atlas Iron Liberia') as id"))[0].id as string;
  const inv = (
    await run(`select public.mg_create_company_admin_invitation('${org}', ' New.Admin@Atlas.test ') as id`)
  )[0].id as string;
  return { org, inv };
}

describe("Ministry: company registration and administrator nomination", () => {
  test("only an administrator can register a company or nominate an administrator", async () => {
    for (const uid of [f.opA, f.county, f.national, f.guest]) {
      await asUser(uid, async (run) => {
        expect(await fails(run("select public.mg_register_company('Hostile Co')"))).toMatch(/FORBIDDEN/);
        expect(
          await fails(run(`select public.mg_create_company_admin_invitation((select id from public.organizations limit 1), 'x@y.zz')`)),
        ).toMatch(/FORBIDDEN/);
      });
    }
  });

  test("registration is validated and duplicate names are refused", async () => {
    await asUser(f.admin, async (run) => {
      expect(await fails(run("select public.mg_register_company(' ')"))).toMatch(/INVALID_NAME/);
      await run("select public.mg_register_company('Atlas Iron Liberia')");
      expect(await fails(run("select public.mg_register_company('ATLAS IRON LIBERIA')"))).toMatch(/DUPLICATE_ORGANIZATION/);
    });
  });

  test("invitation normalizes the email, is retry-safe, stores no secret, and is audited", async () => {
    await asUser(f.admin, async (run) => {
      const { org, inv } = await adminFlow(run);
      const again = (await run(`select public.mg_create_company_admin_invitation('${org}', 'new.admin@atlas.test') as id`))[0].id;
      expect(again).toBe(inv); // same pending invitation, no duplicate
      const row = (await run(`select email, status, org_role, expires_at > now() as live from public.organization_invitations where id = '${inv}'`))[0];
      expect(row).toMatchObject({ email: "new.admin@atlas.test", status: "pending", org_role: "company_admin", live: true });
      const cols = (await run(`select column_name from information_schema.columns where table_name = 'organization_invitations'`)).map((r) => r.column_name);
      expect(cols.some((c) => /token|secret|hash|code/i.test(String(c)))).toBe(false);
      const audit = await run(`select action, actor_label from public.audit_log where entity_id in ('${inv}','${org}') order by created_at`);
      expect(audit.some((a) => a.action === "organization_invitations.insert")).toBe(true);
      expect(audit.every((a) => a.actor_label !== "system")).toBe(true);
    });
  });

  test("government accounts and other companies' members cannot be nominated", async () => {
    await asUser(f.admin, async (run) => {
      const org = (await run("select public.mg_register_company('Atlas Iron Liberia') as id"))[0].id;
      expect(
        await fails(run(`select public.mg_create_company_admin_invitation('${org}', 'dave@mineguard.test')`)),
      ).toMatch(/INELIGIBLE_ACCOUNT/);
    });
  });

  test("a suspended company cannot receive an administrator", async () => {
    await asUser(f.admin, async (run) => {
      const org = (await run("select public.mg_register_company('Atlas Iron Liberia') as id"))[0].id;
      await run(`select public.mg_set_company_status('${org}', 'suspended', 'Pending licence review')`);
      expect(await fails(run(`select public.mg_create_company_admin_invitation('${org}', 'a@b.cc')`))).toMatch(/ORG_NOT_APPROVED/);
    });
  });

  test("invitation table is invisible to non-administrators and not directly writable by anyone", async () => {
    await asUser(f.admin, async (run) => {
      const { org } = await adminFlow(run);
      expect((await run("select id from public.organization_invitations")).length).toBe(1);
      expect(
        await fails(run(`insert into public.organization_invitations (organization_id, email, org_role, expires_at) values ('${org}','x@y.zz','company_admin', now() + interval '1 day')`)),
      ).toMatch(/permission denied/i);
      expect(await fails(run("update public.organization_invitations set status = 'accepted'"))).toMatch(/permission denied/i);
    });
    await asUser(f.opA, async (run) => {
      expect((await run("select id from public.organization_invitations")).length).toBe(0);
    });
  });
});

describe("Invitee: accept", () => {
  test("verified invitee accepts: becomes operator of exactly that company, once", async () => {
    await asPostgres(async (run) => {
      await newUser(run, RIVAL, "new.admin@atlas.test");
      await run(`update public.profiles set email = 'new.admin@atlas.test' where id = '${RIVAL}'`);
      await run("select set_config('request.jwt.claims', '{\"sub\":\"" + f.admin + "\",\"role\":\"authenticated\"}', true)");
      await run("set local role authenticated");
      const { org, inv } = await adminFlow(run);
      await run(`select set_config('request.jwt.claims', '{"sub":"${RIVAL}","role":"authenticated"}', true)`);
      const mine = await run("select * from public.mg_my_pending_invitations()");
      expect(mine.map((m) => m.id)).toEqual([inv]);
      const got = (await run(`select public.mg_accept_invitation('${inv}') as id`))[0].id;
      expect(got).toBe(org);
      const me = (await run("select role, scope, organization_id, operator_name from public.profiles where id = auth.uid()"))[0];
      expect(me).toMatchObject({ role: "operator", scope: "operator", organization_id: org, operator_name: "Atlas Iron Liberia" });
      const mem = await run("select org_role, status from public.organization_members where user_id = auth.uid()");
      expect(mem).toEqual([{ org_role: "company_admin", status: "active" }]);
      // replay: the same invitation can never be used again
      expect(await fails(run(`select public.mg_accept_invitation('${inv}')`))).toMatch(/INVITATION_INVALID/);
      expect((await run("select * from public.mg_my_pending_invitations()")).length).toBe(0);
    });
  });

  test("someone else's invitation, an unverified email, a revoked, and an expired invitation are all refused", async () => {
    await asPostgres(async (run) => {
      await newUser(run, RIVAL, "rival@else.test");
      await run(`update public.profiles set email = 'rival@else.test' where id = '${RIVAL}'`);
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.admin}","role":"authenticated"}', true)`);
      await run("set local role authenticated");
      const { org, inv } = await adminFlow(run);
      // wrong account (valid verified user, different address)
      await run(`select set_config('request.jwt.claims', '{"sub":"${RIVAL}","role":"authenticated"}', true)`);
      expect(await fails(run(`select public.mg_accept_invitation('${inv}')`))).toMatch(/INVITATION_INVALID/);
      expect(await fails(run(`select public.mg_accept_invitation(gen_random_uuid())`))).toMatch(/INVITATION_INVALID/);
      expect((await run("select * from public.mg_my_pending_invitations()")).length).toBe(0);
      // admin revokes
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.admin}","role":"authenticated"}', true)`);
      await run(`select public.mg_revoke_invitation('${inv}')`);
      expect(await fails(run(`select public.mg_revoke_invitation('${inv}')`))).toMatch(/INVITATION_NOT_PENDING/);
      const inv2 = (await run(`select public.mg_create_company_admin_invitation('${org}', 'rival@else.test') as id`))[0].id;
      await run("reset role");
      await run(`update public.organization_invitations set expires_at = now() - interval '1 minute' where id = '${inv2}'`);
      await run("set local role authenticated");
      await run(`select set_config('request.jwt.claims', '{"sub":"${RIVAL}","role":"authenticated"}', true)`);
      expect(await fails(run(`select public.mg_accept_invitation('${inv2}')`))).toMatch(/INVITATION_EXPIRED/);
    });
  });

  test("an unverified email can never accept (pre-registration takeover)", async () => {
    await asPostgres(async (run) => {
      await newUser(run, RIVAL, "victim@atlas.test", false);
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.admin}","role":"authenticated"}', true)`);
      await run("set local role authenticated");
      const { inv } = await adminFlow(run);
      await run(`select set_config('request.jwt.claims', '{"sub":"${RIVAL}","role":"authenticated"}', true)`);
      expect(await fails(run(`select public.mg_accept_invitation('${inv}')`))).toMatch(/EMAIL_NOT_VERIFIED/);
    });
  });

  test("one company per user: an active member of another company is refused (0026 backfills legacy operators)", async () => {
    await asUser(f.admin, async (run) => {
      const org = (await run("select public.mg_register_company('Atlas Iron Liberia') as id"))[0].id;
      expect(
        await fails(run(`select public.mg_create_company_admin_invitation('${org}', 'bob@agrilib.test')`)),
      ).toMatch(/ALREADY_MEMBER_OTHER_ORG/);
    });
  });

  test("accepting does not let the invitee reach any other company or government surface", async () => {
    await asPostgres(async (run) => {
      await newUser(run, RIVAL, "new.admin@atlas.test");
      await run(`update public.profiles set email = 'new.admin@atlas.test' where id = '${RIVAL}'`);
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.admin}","role":"authenticated"}', true)`);
      await run("set local role authenticated");
      const { inv } = await adminFlow(run);
      await run(`select set_config('request.jwt.claims', '{"sub":"${RIVAL}","role":"authenticated"}', true)`);
      await run(`select public.mg_accept_invitation('${inv}')`);
      expect((await run("select id from public.sites")).length).toBe(0); // new company has no sites
      expect((await run("select id from public.audit_log")).length).toBe(0);
      expect(await fails(run("update public.profiles set role = 'admin' where id = auth.uid()"))).toMatch(/FORBIDDEN/);
      expect(await fails(run("select public.mg_register_company('Another')"))).toMatch(/FORBIDDEN/);
      expect(
        await fails(run(`update public.profiles set organization_id = (select id from public.organizations where name = 'OreCo Liberia') where id = auth.uid()`)),
      ).toMatch(/FORBIDDEN/);
    });
  });
});

describe("Company lifecycle enforced by the backend", () => {
  test("suspension locks the company out, reactivation restores it, the Ministry is unaffected, nothing is deleted", async () => {
    await asUser(f.admin, async (run) => {
      const orgA = (await run(`select organization_id as id from public.profiles where id = '${f.opA}'`))[0].id;
      expect(await fails(run(`select public.mg_set_company_status('${orgA}', 'suspended', 'no')`))).toMatch(/REASON_REQUIRED/);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'Safety licence under review')`);
      expect((await run("select id from public.sites")).length).toBeGreaterThan(1); // Ministry still sees everything
      const st = (await run(`select status, status_reason from public.organizations where id = '${orgA}'`))[0];
      expect(st).toMatchObject({ status: "suspended", status_reason: "Safety licence under review" });
      // same transaction, switch to the operator
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.opA}","role":"authenticated"}', true)`);
      expect((await run("select id from public.sites")).length).toBe(0);
      expect((await run("select id from public.incidents")).length).toBe(0);
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.admin}","role":"authenticated"}', true)`);
      await run(`select public.mg_set_company_status('${orgA}', 'approved')`);
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.opA}","role":"authenticated"}', true)`);
      expect((await run("select id from public.sites")).length).toBe(1);
    });
  });

  test("only administrators change company status", async () => {
    await asUser(f.opA, async (run) => {
      expect(
        await fails(run(`select public.mg_set_company_status((select organization_id from public.profiles where id = auth.uid()), 'suspended', 'self-service attempt')`)),
      ).toMatch(/FORBIDDEN/);
      // RLS hides every row from the update: zero rows change, no status can move.
      expect(await run("update public.organizations set status = 'approved' returning id")).toEqual([]);
    });
  });
});
