// Phase B — the invitation edge-function handler, wired to the REAL database
// (PGlite) through a caller-scoped adapter, with a recording fake mailer.
import { beforeAll, describe, expect, test } from "bun:test";
import { handleInviteRequest, type InviteDeps } from "../supabase/functions/_shared/invite/handler";
import { asUser, getFixture, type Runner } from "./helpers/pglite-db";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  const { getDb } = await import("./helpers/pglite-db");
  const db = await getDb();
  for (const m of ["0024_self_service_tenant_lockdown.sql", "0025_company_status_membership_invitations.sql"]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", m), "utf8"));
  }
});

function deps(run: Runner, mail: Partial<InviteDeps["mail"]> = {}, redirectTo: string | null = "https://app.test/invitation") {
  const sent: { kind: string; email: string; redirectTo: string }[] = [];
  const d: InviteDeps = {
    redirectTo,
    db: {
      rpc: async (fn, args) => {
        const keys = Object.keys(args);
        const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
        try {
          const rows = await run(sql, keys.map((k) => args[k]));
          return { data: rows[0]?.r ?? null, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
    },
    mail: {
      invite: async (email, to) => (sent.push({ kind: "invite", email, redirectTo: to }), { error: null }),
      magicLink: async (email, to) => (sent.push({ kind: "magic", email, redirectTo: to }), { error: null }),
      ...mail,
    },
  };
  return { d, sent };
}

async function org(run: Runner) {
  return (await run("select public.mg_register_company('Atlas Iron Liberia') as id"))[0].id as string;
}

describe("company-admin-invite handler", () => {
  test("administrator: creates the invitation and sends exactly one email to the normalized address", async () => {
    await asUser(f.admin, async (run) => {
      const { d, sent } = deps(run);
      const r = await handleInviteRequest(d, { organizationId: await org(run), email: " New.Admin@Atlas.test " });
      expect(r.status).toBe(200);
      expect(r.body.delivery).toBe("invited");
      expect(sent).toEqual([{ kind: "invite", email: "new.admin@atlas.test", redirectTo: "https://app.test/invitation" }]);
    });
  });

  test("non-administrators can never trigger an email", async () => {
    for (const uid of [f.opA, f.county, f.national, f.guest]) {
      await asUser(uid, async (run) => {
        const { d, sent } = deps(run);
        const r = await handleInviteRequest(d, {
          organizationId: "bbbbbbbb-0000-4000-8000-000000000001",
          email: "x@y.zz",
        });
        expect(r.status).toBe(403);
        const r2 = await handleInviteRequest(d, { invitationId: "bbbbbbbb-0000-4000-8000-000000000001" });
        expect(r2.status).toBe(403);
        expect(sent).toEqual([]);
      });
    }
  });

  test("resend is throttled, and an existing account gets a sign-in link instead", async () => {
    await asUser(f.admin, async (run) => {
      const { d, sent } = deps(run, {
        invite: async () => ({ error: { message: "A user with this email address has already been registered", status: 422 } }),
      });
      const first = await handleInviteRequest(d, { organizationId: await org(run), email: "bob@agrilib.test" });
      expect(first.body.delivery).toBe("signin_link");
      expect(sent[0].kind).toBe("magic");
      const again = await handleInviteRequest(d, { invitationId: first.body.invitationId });
      expect(again.status).toBe(429);
      expect(sent.length).toBe(1);
    });
  });

  test("a mail failure keeps the invitation pending and reports it so the admin can resend", async () => {
    await asUser(f.admin, async (run) => {
      const { d } = deps(run, { invite: async () => ({ error: { message: "smtp down" } }) });
      const r = await handleInviteRequest(d, { organizationId: await org(run), email: "a@b.cc" });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("EMAIL_FAILED");
      const st = await run(`select status from public.organization_invitations where id = '${r.body.invitationId}'`);
      expect(st[0].status).toBe("pending");
      expect(JSON.stringify(r.body)).not.toContain("smtp");
    });
  });

  test("input validation and fail-closed configuration", async () => {
    await asUser(f.admin, async (run) => {
      const { d, sent } = deps(run);
      expect((await handleInviteRequest(d, {})).status).toBe(400);
      expect((await handleInviteRequest(d, { invitationId: "not-a-uuid" })).status).toBe(400);
      expect((await handleInviteRequest(d, { organizationId: await org(run), email: "nope" })).status).toBe(400);
      const unconfigured = deps(run, {}, null);
      expect((await handleInviteRequest(unconfigured.d, { invitationId: "bbbbbbbb-0000-4000-8000-000000000001" })).status).toBe(500);
      expect(sent).toEqual([]);
    });
  });

  test("the redirect target is configuration only: a request-supplied redirect is ignored", async () => {
    await asUser(f.admin, async (run) => {
      const { d, sent } = deps(run);
      await handleInviteRequest(d, { organizationId: await org(run), email: "z@y.zz", redirectTo: "https://evil.test" });
      expect(sent[0].redirectTo).toBe("https://app.test/invitation");
    });
  });

  test("source contracts: no service-role use before authorization; no email in logs", () => {
    const fn = readFileSync(join(import.meta.dir, "..", "supabase/functions/company-admin-invite/index.ts"), "utf8");
    const handler = readFileSync(join(import.meta.dir, "..", "supabase/functions/_shared/invite/handler.ts"), "utf8");
    expect(handler).not.toMatch(/console\./);
    expect(fn).not.toMatch(/console\./);
    expect(handler.indexOf("mg_prepare_invitation_send")).toBeLessThan(handler.indexOf("deps.mail.invite"));
    expect(fn).not.toMatch(/\bVITE_|localStorage/);
  });
});
