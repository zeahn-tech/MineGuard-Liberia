// The account-deletion handler wired to the REAL database (PGlite) through a caller-scoped
// adapter, with recording fakes for the privileged login actions.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAccountDeletion, type AccountDeps } from "../supabase/functions/_shared/account/handler";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const ROOT = join(import.meta.dir, "..");
const U1 = "aaaaaaaa-0000-4000-8000-0000000000d1";
const U2 = "aaaaaaaa-0000-4000-8000-0000000000d2";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of ["0034_company_notifications.sql", "0035_profile_settings_photo_deletion.sql"]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
  }
});

function deps(run: Runner, over: Partial<{ password: boolean; deleteFails: boolean; disableFails: boolean }> = {}) {
  const calls: string[] = [];
  const d: AccountDeps = {
    db: {
      rpc: async (fn) => {
        try {
          const rows = await run(`select public.${fn}() as r`);
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
