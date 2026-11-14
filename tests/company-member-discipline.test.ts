// ---------------------------------------------------------------------------
// Migration 0054 — suspend, reinstate, remove and block company members.
// Boundaries under test: only an active administrator of the SAME approved company
// (or the Ministry) may act; never on yourself; a reason is mandatory for suspend
// and block; suspension ends access at once and is reversible; a block closes every
// way back in (request, invitation, import) until lifted; unblocking restores nothing.
// Every case runs inside a rolled-back transaction.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // company admin of AgriLib
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // company admin of OreCo
const W1 = "aaaaaaaa-0000-4000-8000-0000000000c1";
const W2 = "aaaaaaaa-0000-4000-8000-0000000000c2";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql", "0025_company_status_membership_invitations.sql", "0026_company_workforce.sql",
    "0027_site_scoped_access.sql", "0028_account_names_invitation_cleanup.sql", "0029_onboarding_officer_bulk_import.sql",
    "0030_registrar_role_value.sql", "0031_company_registrar.sql", "0032_government_roles_hold_no_company.sql",
    "0033_companies_are_registered_not_typed.sql", "0034_company_notifications.sql", "0035_profile_settings_photo_deletion.sql",
    "0036_site_scoped_update_policies.sql", "0037_company_profile_and_site_requests.sql", "0038_company_activity_history.sql",
    "0039_oversight_and_admin_user_removal.sql", "0048_close_admin_bootstrap.sql", "0049_public_user_identity.sql",
    "0050_public_reports_feedback.sql", "0052_public_content.sql", "0055_company_member_discipline.sql",
  ]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", m), "utf8"));
  }
});

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

/** As XA (AgriLib administrator): W1 is an active worker of AgriLib; YA administers OreCo. */
async function world<T>(fn: (run: Runner, ids: { orgA: string; orgB: string; member: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(
      `insert into auth.users (id, email) values
         ('${XA}','xa@agrilib.test'), ('${YA}','ya@oreco.test'),
         ('${W1}','w1@mail.test'), ('${W2}','w2@mail.test')`,
    );
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run("set local role authenticated");
    await as(run, f.admin);
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, f.admin);
    }
    await as(run, XA);
    const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'w1@mail.test', 'worker') as id`))[0].id;
    await as(run, W1);
    await run(`select public.mg_accept_invitation('${inv}')`);
    await as(run, XA);
    const member = (await run(`select member_id from public.mg_company_workforce('${orgA}') where email = 'w1@mail.test'`))[0].member_id as string;
    return fn(run, { orgA, orgB, member });
  });
}

const profileOf = async (run: Runner, uid: string) => {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await as(run, uid);
  const row = (await run("select role, organization_id from public.profiles where id = auth.uid()"))[0];
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  return row;
};

describe("suspend and reinstate", () => {
  test("suspension needs a written reason and ends access at once", async () => {
    await world(async (run, { orgA, member }) => {
      expect(await fails(run(`select public.mg_suspend_member('${member}', '')`))).toMatch(/REASON_REQUIRED/);
      expect(await fails(run(`select public.mg_suspend_member('${member}', 'abc')`))).toMatch(/REASON_REQUIRED/);
      await run(`select public.mg_suspend_member('${member}', 'Unsafe behaviour on site 2')`);
      expect(await profileOf(run, W1)).toMatchObject({ role: null, organization_id: null });
      const row = (await run(`select status, reason from (select status, status_reason as reason from public.organization_members where id = '${member}') t`))[0];
      expect(row).toMatchObject({ status: "suspended", reason: "Unsafe behaviour on site 2" });
      // listed for the administrator, with the reason
      const team = await run(`select email, status, status_reason from public.mg_company_team('${orgA}') where email = 'w1@mail.test'`);
      expect(team[0]).toMatchObject({ status: "suspended", status_reason: "Unsafe behaviour on site 2" });
      // a suspended person cannot use company administration or see the team
      await as(run, W1);
      expect(await fails(run(`select * from public.mg_company_team('${orgA}')`))).toMatch(/FORBIDDEN/);
    });
  });

  test("reinstating restores the same membership and role", async () => {
    await world(async (run, { orgA, member }) => {
      await run(`select public.mg_suspend_member('${member}', 'Pending investigation')`);
      await run(`select public.mg_reinstate_member('${member}')`);
      expect(await profileOf(run, W1)).toMatchObject({ role: "operator", organization_id: orgA });
      const row = (await run(`select status, org_role, status_reason from public.organization_members where id = '${member}'`))[0];
      expect(row).toMatchObject({ status: "active", org_role: "worker", status_reason: null });
      // not suspended any more, so a second reinstate is refused
      expect(await fails(run(`select public.mg_reinstate_member('${member}')`))).toMatch(/MEMBERSHIP_NOT_ACTIVE/);
    });
  });

  test("a suspended person who joined another company cannot be reinstated into two", async () => {
    await world(async (run, { orgB, member }) => {
      await run(`select public.mg_suspend_member('${member}', 'Pending investigation')`);
      await as(run, YA);
      const inv = (await run(`select public.mg_create_org_invitation('${orgB}', 'w1@mail.test', 'worker') as id`))[0].id;
      await as(run, W1);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, XA);
      expect(await fails(run(`select public.mg_reinstate_member('${member}')`))).toMatch(/ALREADY_MEMBER_OTHER_ORG/);
    });
  });
});

describe("who may act", () => {
  test("workers, other companies and the person themselves cannot suspend, remove or block", async () => {
    await world(async (run, { member }) => {
      await as(run, W1);
      for (const sql of [
        `select public.mg_suspend_member('${member}', 'Because I can')`,
        `select public.mg_remove_member('${member}')`,
        `select public.mg_block_member('${member}', 'Because I can')`,
      ]) expect(await fails(run(sql))).toMatch(/FORBIDDEN/);
      await as(run, YA); // administrator of a DIFFERENT company
      for (const sql of [
        `select public.mg_suspend_member('${member}', 'Not my company')`,
        `select public.mg_remove_member('${member}')`,
        `select public.mg_block_member('${member}', 'Not my company')`,
      ]) expect(await fails(run(sql))).toMatch(/FORBIDDEN/);
      // nothing changed
      await as(run, XA);
      expect((await run(`select status from public.organization_members where id = '${member}'`))[0].status).toBe("active");
    });
  });

  test("an administrator cannot act on themselves; company administrators are the Ministry's to manage", async () => {
    await world(async (run, { orgA }) => {
      const adminRow = (await run(`select member_id from public.mg_company_workforce('${orgA}') where email = 'xa@agrilib.test'`))[0].member_id;
      expect(await fails(run(`select public.mg_suspend_member('${adminRow}', 'Self suspension')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_block_member('${adminRow}', 'Self block')`))).toMatch(/FORBIDDEN/);
      // a second administrator cannot be suspended by a company administrator either
      await as(run, f.admin);
      const inv = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'w2@mail.test') as id`))[0].id;
      await as(run, W2);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, XA);
      const other = (await run(`select member_id from public.mg_company_workforce('${orgA}') where email = 'w2@mail.test'`))[0].member_id;
      expect(await fails(run(`select public.mg_suspend_member('${other}', 'Overreach attempt')`))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("remove", () => {
  test("a suspended member can be removed, with or without a reason, and loses site assignments", async () => {
    await world(async (run, { member }) => {
      await run(`select public.mg_suspend_member('${member}', 'Pending investigation')`);
      await run(`select public.mg_remove_member('${member}', 'Contract ended')`);
      const row = (await run(`select status, status_reason from public.organization_members where id = '${member}'`))[0];
      expect(row).toMatchObject({ status: "revoked", status_reason: "Contract ended" });
      expect(await profileOf(run, W1)).toMatchObject({ role: null, organization_id: null });
      // removal is not a block: they can be invited again
      const again = await run(`select public.mg_create_org_invitation((select organization_id from public.organization_members where id = '${member}'), 'w1@mail.test', 'worker') as id`);
      expect(again[0].id).toBeTruthy();
    });
  });
});

describe("block", () => {
  test("blocking needs a reason, removes the person, cancels their invitations and lists them", async () => {
    await world(async (run, { orgA, member }) => {
      const pending = (await run(`select public.mg_create_org_invitation('${orgA}', 'w1@mail.test', 'safety_officer') as id`))[0].id;
      expect(await fails(run(`select public.mg_block_member('${member}', '  ')`))).toMatch(/REASON_REQUIRED/);
      await run(`select public.mg_block_member('${member}', 'Falsified an inspection record')`);
      expect(await profileOf(run, W1)).toMatchObject({ role: null, organization_id: null });
      expect((await run(`select status from public.organization_members where id = '${member}'`))[0].status).toBe("revoked");
      expect((await run(`select status from public.organization_invitations where id = '${pending}'`))[0].status).toBe("revoked");
      const blocks = await run(`select email, reason from public.mg_company_blocks('${orgA}')`);
      expect(blocks).toEqual([{ email: "w1@mail.test", reason: "Falsified an inspection record" }]);
    });
  });

  test("every way back in is closed: join request, invitation, and the blocked list is private", async () => {
    await world(async (run, { orgA, orgB, member }) => {
      await run(`select public.mg_block_member('${member}', 'Falsified an inspection record')`);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'w1@mail.test', 'worker')`))).toMatch(/BLOCKED_FROM_COMPANY/);
      await as(run, W1);
      expect(await fails(run(`select public.mg_request_membership('${orgA}')`))).toMatch(/BLOCKED_FROM_COMPANY/);
      // the block is per company: OreCo is unaffected
      expect((await run(`select public.mg_request_membership('${orgB}') as id`))[0].id).toBeTruthy();
      // the person cannot read or lift their own block, nor can another company
      expect(await fails(run(`select * from public.mg_company_blocks('${orgA}')`))).toMatch(/FORBIDDEN/);
      await as(run, YA);
      expect(await fails(run(`select * from public.mg_company_blocks('${orgA}')`))).toMatch(/FORBIDDEN/);
    });
  });

  test("a blocked address is reported by the bulk-import check instead of being invited", async () => {
    await world(async (run, { orgA, member }) => {
      await run(`select public.mg_block_member('${member}', 'Falsified an inspection record')`);
      const out = await run(
        `select public.mg_import_check('${orgA}', '[{"email":"w1@mail.test","role":"worker"},{"email":"fresh@mail.test","role":"worker"}]'::jsonb) as r`,
      );
      const rows = (out[0].r ?? out[0]) as { outcome: string }[];
      expect(rows.map((r) => r.outcome)).toEqual(["error", "ok"]);
    });
  });

  test("unblocking lifts the barrier but restores nothing", async () => {
    await world(async (run, { orgA, member }) => {
      await run(`select public.mg_block_member('${member}', 'Falsified an inspection record')`);
      const blockId = (await run(`select block_id from public.mg_company_blocks('${orgA}')`))[0].block_id;
      await as(run, YA);
      expect(await fails(run(`select public.mg_unblock('${blockId}')`))).toMatch(/FORBIDDEN/);
      await as(run, XA);
      await run(`select public.mg_unblock('${blockId}')`);
      expect(await fails(run(`select public.mg_unblock('${blockId}')`))).toMatch(/BLOCK_NOT_ACTIVE/);
      expect((await run(`select * from public.mg_company_blocks('${orgA}')`)).length).toBe(0);
      expect(await profileOf(run, W1)).toMatchObject({ role: null, organization_id: null }); // still no access
      // ...but they may now request to join again, which an administrator must still approve
      await as(run, W1);
      expect((await run(`select public.mg_request_membership('${orgA}') as id`))[0].id).toBeTruthy();
      expect(await profileOf(run, W1)).toMatchObject({ role: null, organization_id: null });
    });
  });

  test("blocking a suspended member works and closes the membership", async () => {
    await world(async (run, { member }) => {
      await run(`select public.mg_suspend_member('${member}', 'Pending investigation')`);
      await run(`select public.mg_block_member('${member}', 'Investigation upheld')`);
      expect((await run(`select status from public.organization_members where id = '${member}'`))[0].status).toBe("revoked");
      expect(await fails(run(`select public.mg_reinstate_member('${member}')`))).toMatch(/MEMBERSHIP_NOT_ACTIVE/);
    });
  });
});
