// ---------------------------------------------------------------------------
// Migration 0035 — profile settings, profile photo, self-service account deletion.
// Every case rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asUser, getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const ROOT = join(import.meta.dir, "..");
const U1 = "aaaaaaaa-0000-4000-8000-0000000000d1";
const U2 = "aaaaaaaa-0000-4000-8000-0000000000d2";
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1";
const XB = "aaaaaaaa-0000-4000-8000-0000000000a2";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0033_companies_are_registered_not_typed.sql", "0034_company_notifications.sql",
    "0035_profile_settings_photo_deletion.sql", "0036_site_scoped_update_policies.sql", "0037_company_profile_and_site_requests.sql",
  ]) await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
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
async function owner(run: Runner, sql: string) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  await run("set local role authenticated");
  return rows;
}

describe("profile settings", () => {
  test("a person edits their own name and job title; the rules are enforced by the database", async () => {
    await asUser(f.opA, async (run) => {
      await run("select public.mg_update_my_profile('  Ada  Lovelace ', ' Safety lead ')");
      expect((await run("select name, job_title from public.profiles where id = auth.uid()"))[0]).toEqual({ name: "Ada  Lovelace", job_title: "Safety lead" });
      await run("select public.mg_update_my_profile('Ada Lovelace', '')");
      expect((await run("select job_title from public.profiles where id = auth.uid()"))[0].job_title).toBeNull();
      expect(await fails(run("select public.mg_update_my_profile('A', null)"))).toMatch(/INVALID_NAME/);
      expect(await fails(run(`select public.mg_update_my_profile('${"x".repeat(121)}', null)`))).toMatch(/INVALID_NAME/);
      expect(await fails(run(`select public.mg_update_my_profile('Ada', '${"y".repeat(121)}')`))).toMatch(/INVALID_JOB_TITLE/);
    });
  });

  test("editing details can never change role, company, scope or email", async () => {
    await asUser(f.opA, async (run) => {
      const before = (await run("select role, scope, organization_id, email from public.profiles where id = auth.uid()"))[0];
      await run("select public.mg_update_my_profile('Someone Else', 'Admin')");
      expect((await run("select role, scope, organization_id, email from public.profiles where id = auth.uid()"))[0]).toEqual(before);
      expect(await fails(run("update public.profiles set email = 'x@y.zz' where id = auth.uid()"))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("profile photo", () => {
  test("only the owner's own file can be written; others cannot read, overwrite or remove it", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','u1@x.test'), ('${U2}','u2@x.test')`);
      await run("set local role authenticated");
      await as(run, U1);
      await run(`insert into storage.objects (bucket_id, name) values ('avatars', '${U1}/avatar.jpg')`);
      expect(await fails(run(`insert into storage.objects (bucket_id, name) values ('avatars', '${U2}/avatar.jpg')`))).toMatch(/row-level|policy|violat/i);
      expect(await fails(run(`insert into storage.objects (bucket_id, name) values ('avatars', '${U1}/other.png')`))).toMatch(/row-level|policy|violat/i);
      expect(await fails(run(`insert into storage.objects (bucket_id, name) values ('avatars', '${U1}/nested/avatar.jpg')`))).toMatch(/row-level|policy|violat/i);
      await as(run, U2);
      expect((await run("select name from storage.objects where bucket_id = 'avatars'")).length).toBe(0); // cannot see U1's photo
      expect(await run(`delete from storage.objects where name = '${U1}/avatar.jpg' returning name`)).toEqual([]);
      expect(await run(`update storage.objects set name = '${U2}/avatar.jpg' where name = '${U1}/avatar.jpg' returning name`)).toEqual([]);
      await as(run, f.admin);
      expect((await run("select name from storage.objects where bucket_id = 'avatars'")).length).toBe(0); // not even the administrator
    });
  });

  test("the profile only ever points at the person's own, existing file", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','u1@x.test')`);
      await run("set local role authenticated");
      await as(run, U1);
      expect(await fails(run("select public.mg_set_my_avatar(true)"))).toMatch(/AVATAR_NOT_UPLOADED/);
      await run(`insert into storage.objects (bucket_id, name) values ('avatars', '${U1}/avatar.jpg')`);
      await run("select public.mg_set_my_avatar(true)");
      expect((await run("select avatar_path from public.profiles where id = auth.uid()"))[0].avatar_path).toBe(`${U1}/avatar.jpg`);
      expect(await fails(run(`update public.profiles set avatar_path = '${f.admin}/avatar.jpg' where id = auth.uid()`))).toMatch(/profiles_avatar_path_check|violat|check/i);
      await run("select public.mg_set_my_avatar(false)");
      expect((await run("select avatar_path from public.profiles where id = auth.uid()"))[0].avatar_path).toBeNull();
    });
  });

  test("the bucket is private, small and JPEG-only", async () => {
    await withRole("postgres", null, async (run) => {
      expect((await run("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars'"))[0]).toEqual({
        public: false, file_size_limit: 2097152, allowed_mime_types: ["image/jpeg"],
      });
    });
  });
});

describe("deletion: what blocks it", () => {
  test("the last platform administrator cannot delete themselves; with another administrator they can", async () => {
    await withRole("postgres", null, async (run) => {
      await run("set local role authenticated");
      await as(run, f.admin);
      const b = (await run("select public.mg_account_deletion_blockers() as b"))[0].b as { code: string }[];
      expect(b.map((x) => x.code)).toEqual(["LAST_ADMIN"]);
      expect(await fails(run("select public.mg_prepare_account_deletion()"))).toMatch(/BLOCKED: You are the only administrator/);
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBe("admin"); // nothing changed
      await owner(run, `insert into auth.users (id, email) values ('${U1}','second.admin@x.test')`);
      await owner(run, `update public.profiles set role = 'admin', scope = 'national', profile_complete = true where id = '${U1}'`);
      expect((await run("select public.mg_account_deletion_blockers() as b"))[0].b).toEqual([]);
    });
  });

  test("the sole administrator of a company cannot leave it headless", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${XA}','xa@agrilib.test'), ('${XB}','xb@agrilib.test')`);
      const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
      await run("set local role authenticated");
      await as(run, f.admin);
      const i1 = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xa@agrilib.test') as id`))[0].id;
      await as(run, XA);
      await run(`select public.mg_accept_invitation('${i1}')`);
      const b = (await run("select public.mg_account_deletion_blockers() as b"))[0].b as { code: string; message: string }[];
      expect(b.map((x) => x.code)).toEqual(["SOLE_COMPANY_ADMIN"]);
      expect(b[0].message).toContain("AgriLib Mining");
      expect(await fails(run("select public.mg_prepare_account_deletion()"))).toMatch(/BLOCKED/);
      // a second administrator frees them
      await as(run, f.admin);
      const i2 = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xb@agrilib.test') as id`))[0].id;
      await as(run, XB);
      await run(`select public.mg_accept_invitation('${i2}')`);
      await as(run, XA);
      expect((await run("select public.mg_account_deletion_blockers() as b"))[0].b).toEqual([]);
    });
  });
});

describe("deletion: the two outcomes", () => {
  test("no records of their own: personal rows go, the login can be removed outright, others are untouched", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email, raw_user_meta_data) values ('${U1}','leaver@x.test','{"name":"Leaver"}'), ('${U2}','stayer@x.test','{"name":"Stayer"}')`);
      const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
      await run("set local role authenticated");
      await as(run, f.admin);
      await run(`select public.mg_create_org_invitation('${orgA}', 'leaver@x.test', 'worker')`);
      await run(`select public.mg_create_org_invitation('${orgA}', 'stayer@x.test', 'worker')`);
      await as(run, U1);
      await run("select public.mg_accept_invitation((select id from public.mg_my_pending_invitations() limit 1))");
      await as(run, U2);
      await run("select public.mg_accept_invitation((select id from public.mg_my_pending_invitations() limit 1))");
      await as(run, U1);
      const out = (await run("select public.mg_prepare_account_deletion() as r"))[0].r as { hasRecords: boolean; avatarPath: string | null };
      expect(out).toEqual({ hasRecords: false, avatarPath: null });
      expect((await run("select name, role, organization_id, deleted_at is not null as gone from public.profiles where id = auth.uid()"))[0]).toEqual({ name: "Deleted user", role: null, organization_id: null, gone: true });
      expect((await run("select id from public.notifications")).length).toBe(0);
      // the login can now be deleted without a single foreign-key complaint, and nobody else is affected
      await run("reset role");
      await run("select set_config('request.jwt.claims', '', true)");
      await run(`delete from auth.users where id = '${U1}'`);
      expect(await run(`select id from public.profiles where id = '${U1}'`)).toEqual([]);
      expect((await run(`select role from public.profiles where id = '${U2}'`))[0].role).toBe("operator");
      expect((await run(`select status from public.organization_members where user_id = '${U2}'`))[0].status).toBe("active");
    });
  });

  test("they own safety records: nothing is deleted, history stays under 'Deleted user', the login must be disabled instead", async () => {
    await withRole("postgres", null, async (run) => {
      // a second platform administrator exists, so nobody here is "the last administrator"
      await run(`insert into auth.users (id, email) values ('${U2}','backup.admin@x.test')`);
      await run(`update public.profiles set role = 'admin', scope = 'national', profile_complete = true where id = '${U2}'`);
      const owner1 = (await run("select inspector_id as id from public.inspections limit 1"))[0].id as string;
      const before = {
        inspections: (await run("select count(*)::int as n from public.inspections"))[0].n,
        findings: (await run("select count(*)::int as n from public.findings"))[0].n,
      };
      await run("set local role authenticated");
      await as(run, owner1);
      const out = (await run("select public.mg_prepare_account_deletion() as r"))[0].r as { hasRecords: boolean };
      expect(out.hasRecords).toBe(true);
      expect((await run("select name, role, email like 'deleted-%@deleted.invalid' as anon from public.profiles where id = auth.uid()"))[0]).toEqual({ name: "Deleted user", role: null, anon: true });
      await run("reset role");
      await run("select set_config('request.jwt.claims', '', true)");
      expect((await run("select count(*)::int as n from public.inspections"))[0].n).toBe(before.inspections);
      expect((await run("select count(*)::int as n from public.findings"))[0].n).toBe(before.findings);
      // a hard delete would be refused by the database: that is exactly why the function reports hasRecords
      let blocked = "";
      try {
        await run(`delete from auth.users where id = '${owner1}'`);
      } catch (e) {
        blocked = String((e as Error).message);
      }
      expect(blocked).toMatch(/foreign key|violates/i);
    });
  });

  test("it is safe to run twice, and a client cannot clear anyone else's notifications", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','leaver@x.test')`);
      await run("set local role authenticated");
      await as(run, U1);
      await run("select public.mg_prepare_account_deletion()");
      expect((await run("select public.mg_prepare_account_deletion() as r"))[0].r).toMatchObject({ hasRecords: false });
      await as(run, f.opA);
      await expect(run("delete from public.notifications")).rejects.toThrow(/IMMUTABLE|permission denied/i);
    });
  });
});
