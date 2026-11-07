// The account-deletion handler wired to the REAL database (PGlite) through a caller-scoped
// adapter, with recording fakes for the privileged login actions.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAccountDeletion, handleAdminAccountRemoval, type AccountDeps } from "../supabase/functions/_shared/account/handler";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const ROOT = join(import.meta.dir, "..");
const U1 = "aaaaaaaa-0000-4000-8000-0000000000d1";
const U2 = "aaaaaaaa-0000-4000-8000-0000000000d2";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of ["0034_company_notifications.sql", "0035_profile_settings_photo_deletion.sql", "0036_site_scoped_update_policies.sql", "0037_company_profile_and_site_requests.sql", "0038_company_activity_history.sql", "0039_oversight_and_admin_user_removal.sql"]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
  }
});

function deps(run: Runner, over: Partial<{ password: boolean; deleteFails: boolean; disableFails: boolean }> = {}) {
  const calls: string[] = [];
  const d: AccountDeps = {
    db: {
      rpc: async (fn, args = {}) => {
        try {
          const keys = Object.keys(args);
          const rows = await run(
            `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
            keys.map((k) => args[k]),
          );
          return { data: rows[0]?.r ?? null, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
    },
    verifyPassword: async () => (calls.push("verify"), over.password ?? true),
    admin: {
      removeAvatar: async (p) => void calls.push(`avatar:${p}`),
      deleteUser: async (id) => (calls.push(`delete:${id}`), { error: over.deleteFails ? { message: "fk" } : null }),
      disableUser: async (id) => (calls.push(`disable:${id}`), { error: over.disableFails ? { message: "x" } : null }),
      endSessions: async () => void calls.push("signout"),
    },
  };
  return { d, calls };
}
const GOOD = { confirm: "DELETE", password: "correct horse" };

async function asCaller(run: Runner, uid: string) {
  await run("set local role authenticated");
  await run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
}

describe("account-delete handler", () => {
  test("without the typed confirmation or the password nothing happens — not even a database call", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','u1@x.test')`);
      await asCaller(run, U1);
      const { d, calls } = deps(run);
      expect((await handleAccountDeletion(d, { id: U1, email: "u1@x.test" }, { password: "p" })).status).toBe(400);
      expect((await handleAccountDeletion(d, { id: U1, email: "u1@x.test" }, { confirm: "delete", password: "p" })).status).toBe(400);
      expect((await handleAccountDeletion(d, { id: U1, email: "u1@x.test" }, { confirm: "DELETE" })).status).toBe(400);
      expect((await handleAccountDeletion(d, { id: U1, email: null }, GOOD)).status).toBe(400);
      expect(calls).toEqual([]);
      expect((await run("select deleted_at from public.profiles where id = auth.uid()"))[0].deleted_at).toBeNull();
    });
  });

  test("a wrong password stops everything: the profile is untouched", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','u1@x.test')`);
      await asCaller(run, U1);
      const { d, calls } = deps(run, { password: false });
      const r = await handleAccountDeletion(d, { id: U1, email: "u1@x.test" }, GOOD);
      expect(r).toMatchObject({ status: 403, body: { error: "WRONG_PASSWORD" } });
      expect(calls).toEqual(["verify"]);
      expect((await run("select deleted_at from public.profiles where id = auth.uid()"))[0].deleted_at).toBeNull();
    });
  });

  test("blocked by the database (last administrator): nothing is removed and the person is told why", async () => {
    await withRole("postgres", null, async (run) => {
      await asCaller(run, f.admin);
      const { d, calls } = deps(run);
      const r = await handleAccountDeletion(d, { id: f.admin, email: "admin@x.test" }, GOOD);
      expect(r).toMatchObject({ status: 409, body: { error: "BLOCKED" } });
      expect(String(r.body.message)).toContain("only administrator");
      expect(calls).toEqual(["verify"]); // the login was never touched
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBe("admin");
    });
  });

  test("no records: the login is deleted outright, the photo removed, sessions ended", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','u1@x.test')`);
      await asCaller(run, U1);
      await run(`insert into storage.objects (bucket_id, name) values ('avatars', '${U1}/avatar.jpg')`);
      await run("select public.mg_set_my_avatar(true)");
      const { d, calls } = deps(run);
      const r = await handleAccountDeletion(d, { id: U1, email: "u1@x.test" }, GOOD);
      expect(r).toEqual({ status: 200, body: { deleted: true, mode: "removed" } });
      expect(calls).toEqual(["verify", `avatar:${U1}/avatar.jpg`, `delete:${U1}`, "signout"]);
    });
  });

  test("owns records: the login is disabled and anonymized, never deleted, and the records stay", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U2}','backup@x.test')`);
      await run(`update public.profiles set role = 'admin', scope = 'national', profile_complete = true where id = '${U2}'`);
      const owner = (await run("select inspector_id as id from public.inspections limit 1"))[0].id as string;
      const before = (await run("select count(*)::int as n from public.inspections"))[0].n;
      await asCaller(run, owner);
      const { d, calls } = deps(run);
      const r = await handleAccountDeletion(d, { id: owner, email: "x@x.test" }, GOOD);
      expect(r).toEqual({ status: 200, body: { deleted: true, mode: "anonymized" } });
      expect(calls).toEqual(["verify", `disable:${owner}`, "signout"]);
      await run("reset role");
      expect((await run("select count(*)::int as n from public.inspections"))[0].n).toBe(before);
    });
  });

  test("if the login cannot be deleted it falls back to disabling; if that fails too the caller is told to retry", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${U1}','u1@x.test')`);
      await asCaller(run, U1);
      const a = deps(run, { deleteFails: true });
      expect((await handleAccountDeletion(a.d, { id: U1, email: "u1@x.test" }, GOOD)).body).toMatchObject({ mode: "anonymized" });
      expect(a.calls).toContain(`delete:${U1}`);
      expect(a.calls).toContain(`disable:${U1}`);
      const b = deps(run, { deleteFails: true, disableFails: true });
      const r = await handleAccountDeletion(b.d, { id: U1, email: "u1@x.test" }, GOOD); // second run is safe (idempotent)
      expect(r).toMatchObject({ status: 500, body: { error: "INCOMPLETE" } });
      expect(JSON.stringify(r.body)).not.toMatch(/@|password|token/i);
    });
  });

  test("source contract: no logging, and the service key is only used behind the handler", () => {
    const h = readFileSync(join(ROOT, "supabase/functions/_shared/account/handler.ts"), "utf8");
    const i = readFileSync(join(ROOT, "supabase/functions/account-delete/index.ts"), "utf8");
    expect(h).not.toMatch(/console\./);
    expect(i).not.toMatch(/console\./);
    expect(h.indexOf("verifyPassword")).toBeLessThan(h.indexOf("mg_prepare_account_deletion"));
    expect(h.indexOf("mg_prepare_account_deletion")).toBeLessThan(h.indexOf("deps.admin.deleteUser"));
    expect(i).not.toMatch(/\bVITE_/);
  });
});

describe("account-delete handler: an administrator removes someone else (migration 0039)", () => {
  const TARGET = "aaaaaaaa-0000-4000-8000-0000000000e1";
  const XA = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const ADMIN = { id: "", email: "admin@x.test" };

  async function setup(run: Runner) {
    await run(`insert into auth.users (id, email) values ('${TARGET}','target@x.test'), ('${XA}','xa@agrilib.test')`);
    await run(`insert into auth.users (id, email) values ('aaaaaaaa-0000-4000-8000-0000000000e9','second.admin@x.test')`);
    await run("update public.profiles set role = 'admin', scope = 'national', profile_complete = true where id = 'aaaaaaaa-0000-4000-8000-0000000000e9'");
    await asCaller(run, f.admin);
    return { ...ADMIN, id: f.admin };
  }
  const body = (over: Record<string, unknown> = {}) => ({ confirm: "DELETE", password: "pw", targetUserId: TARGET, confirmEmail: "target@x.test", ...over });

  test("the administrator's own password and typed confirmations come first; nothing is touched without them", async () => {
    await withRole("postgres", null, async (run) => {
      const admin = await setup(run);
      const { d, calls } = deps(run);
      for (const bad of [{ confirm: "yes" }, { targetUserId: "nope" }, { confirmEmail: "" }, { password: "" }, { targetUserId: admin.id }]) {
        expect((await handleAdminAccountRemoval(d, admin, body(bad))).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await handleAdminAccountRemoval(deps(run, { password: false }).d, admin, body())).status).toBe(403);
      expect(calls).toEqual([]);
      expect((await run(`select deleted_at from public.profiles where id = '${TARGET}'`))[0].deleted_at).toBeNull();
    });
  });

  test("no records: the target's login is deleted outright; the administrator's session is NOT signed out", async () => {
    await withRole("postgres", null, async (run) => {
      const admin = await setup(run);
      const { d, calls } = deps(run);
      const r = await handleAdminAccountRemoval(d, admin, body());
      expect(r).toEqual({ status: 200, body: { removed: true, mode: "removed" } });
      expect(calls).toEqual(["verify", `delete:${TARGET}`]); // no "signout": that would end the ADMINISTRATOR's own session
    });
  });

  test("the database refuses and the login is never touched: wrong email, blocked, or not an administrator", async () => {
    await withRole("postgres", null, async (run) => {
      const admin = await setup(run);
      const a = deps(run);
      expect(await handleAdminAccountRemoval(a.d, admin, body({ confirmEmail: "other@x.test" }))).toMatchObject({ status: 400, body: { error: "CONFIRM_MISMATCH" } });
      expect(await handleAdminAccountRemoval(a.d, admin, body({ targetUserId: "aaaaaaaa-0000-4000-8000-0000000000ff" }))).toMatchObject({ status: 404 });
      expect(a.calls).toEqual(["verify", "verify"]); // password checked, then the database said no
      await asCaller(run, f.county); // a staff member without users.manage
      const b = deps(run);
      expect(await handleAdminAccountRemoval(b.d, { id: f.county, email: "c@x.test" }, body())).toMatchObject({ status: 403, body: { error: "FORBIDDEN" } });
      expect(b.calls).toEqual(["verify"]);
    });
  });
});
