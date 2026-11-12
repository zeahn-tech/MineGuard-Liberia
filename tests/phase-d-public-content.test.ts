// ---------------------------------------------------------------------------
// Public User programme — Phase D (migration 0051): approved public content, the publication
// lifecycle (draft -> pending_review -> approved -> published -> archived), four-eyes review,
// the glossary draft seed, and the retirement of live anonymous statistics.
// Real Postgres (PGlite) with the production migrations; every session rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  // Other files re-apply older migrations on the shared DB: assert the real end state.
  const db = await getDb();
  for (const m of [
    "0047_close_admin_bootstrap.sql",
    "0048_public_user_identity.sql",
    "0049_public_reports_feedback.sql",
    "0051_public_content.sql",
  ]) {
    await db.exec(read(`supabase/migrations/${m}`));
  }
}, 120000);

const PUB = "dddd0050-0000-4000-8000-000000000001"; // verified public user
const ANON = "dddd0050-0000-4000-8000-000000000002"; // anonymous guest

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

async function world(run: Runner) {
  await run(`insert into auth.users (id, email, email_confirmed_at) values
    ('${PUB}', 'pub@example.org', now()), ('${ANON}', null, null)`);
}
const as = (run: Runner, uid: string, anonymous = false) =>
  run("set local role authenticated").then(() =>
    run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated", is_anonymous: anonymous })}', true)`),
  );
const back = (run: Runner) => run("reset role");
const q = (s: string) => s.replace(/'/g, "''");

// admin = author+review+publish; supervisor (f.national) = author+review; inspector/operator/public = none
const SUP = () => f.national;
const ADM = () => f.admin;

const save = (run: Runner, o: { kind?: string; slug: string; title?: string; body?: string; category?: string | null; data?: string | null; id?: string; publishAt?: string; expiresAt?: string }) =>
  run(`select public.mg_content_save(
      ${o.id ? `'${o.id}'` : "null"}, '${o.kind ?? "glossary_term"}', '${o.slug}', '${q(o.title ?? "Test term")}', null,
      '${q(o.body ?? "A clear definition of the term in plain words.")}',
      ${o.category === null ? "null" : `'${o.category ?? "General"}'`}, ${o.data ?? "null"},
      ${o.publishAt ? `'${o.publishAt}'` : "null"}, ${o.expiresAt ? `'${o.expiresAt}'` : "null"}) as id`).then((r) => r[0].id as string);
const go = (run: Runner, id: string, to: string, note: string | null = null, checks: string | null = null) =>
  run(`select public.mg_content_transition('${id}', '${to}', ${note ? `'${q(note)}'` : "null"}, ${checks ? `'${checks}'::jsonb` : "null"})`);
const ALL_CHECKS = `{"accuracy":true,"completeness":true,"confidentiality":true}`;
const NOTE = "Reviewed against the Ministry safety manual.";

/** author (supervisor) -> reviewer+publisher (admin): a normal publication. Returns the content id. */
async function publish(run: Runner, o: Parameters<typeof save>[1]) {
  await back(run);
  await as(run, SUP());
  const id = await save(run, o);
  await go(run, id, "pending_review");
  await back(run);
  await as(run, ADM());
  await go(run, id, "approved", NOTE, ALL_CHECKS);
  await go(run, id, "published");
  await back(run);
  return id;
}
const visible = async (run: Runner, where = "true") => (await run(`select slug, version from public.public_content where ${where} order by slug, version`)) as { slug: string; version: number }[];

describe("0051: what the public can and cannot read", () => {
  test("anyone — no session, guest, public user, operator, inspector — sees only PUBLISHED rows (not draft, pending, approved or archived)", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await publish(run, { slug: "adit", title: "Adit" });
      const retired = await publish(run, { slug: "retired", title: "Retired" });
      await as(run, ADM());
      await go(run, retired, "archived", "withdrawn: superseded by a new term");
      await back(run);
      await as(run, SUP());
      await save(run, { slug: "draft-term" });
      const pend = await save(run, { slug: "pending-term" });
      await go(run, pend, "pending_review");
      const appr = await save(run, { slug: "approved-term" });
      await go(run, appr, "pending_review");
      await back(run);
      await as(run, ADM());
      await go(run, appr, "approved", NOTE, ALL_CHECKS);
      await back(run);
      expect((await run("select count(*)::int as n from public.public_content"))[0].n).toBe(5); // all five exist
      for (const [label, setup] of [
        ["anon role", async () => { await run("set local role anon"); }],
        ["guest", async () => as(run, ANON, true)],
        ["public user", async () => as(run, PUB)],
        ["operator", async () => as(run, f.opA)],
        ["inspector", async () => as(run, f.county)],
        ["supervisor", async () => as(run, SUP())],
      ] as const) {
        await back(run);
        await setup();
        expect((await visible(run)).map((r) => r.slug), label).toEqual(["adit"]);
      }
    });
  });

  test("only the public columns are readable — provenance, authors and editors are not, even for administrators", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await publish(run, { slug: "adit" });
      for (const [label, setup] of [
        ["anon", async () => { await run("set local role anon"); }],
        ["public user", async () => as(run, PUB)],
        ["administrator", async () => as(run, ADM())],
      ] as const) {
        await back(run);
        await setup();
        for (const col of ["source", "author_id", "edited_by", "status", "content_key", "*"]) {
          expect(await denied(run(`select ${col} from public.public_content`)), `${label}:${col}`).toMatch(/permission denied/i);
        }
        const ok = await run("select id, kind, slug, title, body, category, data, version, published_at, summary, language from public.public_content");
        expect(ok.length).toBe(1);
      }
    });
  });

  test("no client can write the tables or read the history directly", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const id = await publish(run, { slug: "adit" });
      for (const [label, setup] of [
        ["anon", async () => { await run("set local role anon"); }],
        ["guest", async () => as(run, ANON, true)],
        ["public user", async () => as(run, PUB)],
        ["supervisor", async () => as(run, SUP())],
        ["administrator", async () => as(run, ADM())],
      ] as const) {
        await back(run);
        await setup();
        for (const stmt of [
          `insert into public.public_content (kind, slug, title) values ('announcement', 'sneaky', 'Sneaky')`,
          `update public.public_content set title = 'Changed' where id = '${id}'`,
          `delete from public.public_content where id = '${id}'`,
          `select count(*) from public.public_content_events`,
          `insert into public.public_content_events (content_id, action) values ('${id}', 'publish')`,
        ]) {
          expect(await denied(run(stmt)), `${label}: ${stmt}`).toMatch(/permission denied|row-level security/i);
        }
      }
    });
  });

  test("scheduled and expired content is not visible", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await publish(run, { slug: "soon", publishAt: "2999-01-01T00:00:00Z" });
      await publish(run, { slug: "gone", expiresAt: "2001-01-01T00:00:00Z", publishAt: "2000-01-01T00:00:00Z" });
      await publish(run, { slug: "live", publishAt: "2000-01-01T00:00:00Z", expiresAt: "2999-01-01T00:00:00Z" });
      await run("set local role anon");
      expect((await visible(run)).map((r) => r.slug)).toEqual(["live"]);
    });
  });
});

describe("0051: the lifecycle", () => {
  test("a normal publication leaves a complete, attributed history; a revision replaces the old version when published", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const v1 = await publish(run, { slug: "adit", title: "Adit" });
      await as(run, ADM());
      const d1 = (await run(`select public.mg_content_get('${v1}') as d`))[0].d as { status: string; events: { action: string; actor: string; checks: unknown }[] };
      expect(d1.status).toBe("published");
      // Events carry clock_timestamp(); the in-process test database has a millisecond clock, so two
      // steps can share a timestamp and the database order between them is arbitrary. Compare in
      // lifecycle order for ties (production Postgres has microsecond resolution).
      const LIFECYCLE = ["create", "submit", "approve", "publish"];
      const ordered = [...(d1.events as { action: string; at?: string; checks: unknown }[])]
        .sort((a, b) => String(a.at).localeCompare(String(b.at)) || LIFECYCLE.indexOf(a.action) - LIFECYCLE.indexOf(b.action));
      expect(ordered.map((e) => e.action)).toEqual(LIFECYCLE);
      expect(ordered[2].checks).toEqual({ accuracy: true, completeness: true, confidentiality: true });
      await back(run);

      await as(run, SUP());
      const v2 = (await run(`select public.mg_content_revise('${v1}') as id`))[0].id as string;
      await save(run, { id: v2, slug: "adit", title: "Adit (revised)", body: "A revised and clearer definition of the term." });
      await go(run, v2, "pending_review");
      await back(run);
      await run("set local role anon");
      expect((await visible(run)).map((r) => `${r.slug}:${r.version}`)).toEqual(["adit:1"]); // revision not public yet
      await back(run);
      await as(run, ADM());
      await go(run, v2, "approved", NOTE, ALL_CHECKS);
      await go(run, v2, "published");
      await back(run);
      await run("set local role anon");
      expect((await visible(run)).map((r) => `${r.slug}:${r.version}`)).toEqual(["adit:2"]); // v1 archived automatically
    });
  });

  test("four-eyes: nobody approves what they wrote or last edited", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, SUP());
      const mine = await save(run, { slug: "mine" });
      await go(run, mine, "pending_review");
      expect(await denied(go(run, mine, "approved", NOTE, ALL_CHECKS))).toContain("cannot approve content you wrote");
      await back(run);
      await as(run, ADM());
      const theirs = await save(run, { slug: "theirs" });
      await go(run, theirs, "pending_review");
      expect(await denied(go(run, theirs, "approved", NOTE, ALL_CHECKS))).toContain("cannot approve content you wrote");
      // an administrator who last edited someone else's draft cannot approve it either
      await back(run);
      await as(run, SUP());
      const shared = await save(run, { slug: "shared" });
      await back(run);
      await as(run, ADM());
      await save(run, { id: shared, slug: "shared", title: "Edited by the administrator" });
      await go(run, shared, "pending_review");
      expect(await denied(go(run, shared, "approved", NOTE, ALL_CHECKS))).toContain("cannot approve content you wrote or last edited");
    });
  });

  test("approval needs a real note and all three confirmations", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, SUP());
      const id = await save(run, { slug: "needs-checks" });
      await go(run, id, "pending_review");
      await back(run);
      await as(run, ADM());
      expect(await denied(go(run, id, "approved", "ok", ALL_CHECKS))).toMatch(/at least 10/);
      expect(await denied(go(run, id, "approved", NOTE, null))).toMatch(/confirm accuracy/);
      for (const k of ["accuracy", "completeness", "confidentiality"]) {
        const checks = JSON.stringify({ accuracy: true, completeness: true, confidentiality: true, [k]: false });
        expect(await denied(go(run, id, "approved", NOTE, checks)), k).toMatch(/confirm accuracy/);
      }
      await go(run, id, "approved", NOTE, ALL_CHECKS);
    });
  });

  test("only the publish permission publishes or archives; a supervisor cannot", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ADM());
      const id = await save(run, { slug: "pub-test" });
      await go(run, id, "pending_review");
      await back(run);
      await as(run, SUP());
      await go(run, id, "approved", NOTE, ALL_CHECKS);
      expect(await denied(go(run, id, "published"))).toContain("publisher permission");
      await back(run);
      await as(run, ADM());
      await go(run, id, "published");
      await back(run);
      await as(run, SUP());
      expect(await denied(go(run, id, "archived", "withdrawing this term now"))).toContain("publisher permission");
      await back(run);
      await as(run, ADM());
      expect(await denied(go(run, id, "archived", "short"))).toMatch(/at least 10/);
      await go(run, id, "archived", "withdrawn: the definition was superseded");
      await back(run);
      await run("set local role anon");
      expect((await visible(run)).length).toBe(0);
    });
  });

  test("published, approved and archived content is immutable; only drafts are editable", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const id = await publish(run, { slug: "frozen" });
      await as(run, ADM());
      expect(await denied(save(run, { id, slug: "frozen", title: "Rewritten after publication" }))).toContain("IMMUTABLE");
      await back(run);
      // belt and braces: even the owner role cannot rewrite a published row
      expect(await denied(run(`update public.public_content set body = 'tampered' where id = '${id}'`))).toContain("IMMUTABLE");
      // returning to draft needs a reason and re-opens editing
      await as(run, SUP());
      const d = await save(run, { slug: "movable" });
      await go(run, d, "pending_review");
      await back(run);
      await as(run, ADM());
      await go(run, d, "approved", NOTE, ALL_CHECKS);
      expect(await denied(save(run, { id: d, slug: "movable", title: "Edit while approved" }))).toContain("IMMUTABLE");
      expect(await denied(go(run, d, "draft", "x"))).toMatch(/at least 10/);
      await go(run, d, "draft", "needs another example before release");
      await save(run, { id: d, slug: "movable", title: "Edited again as a draft" });
    });
  });

  test("illegal transitions are refused", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ADM());
      const d = await save(run, { slug: "t1" });
      for (const to of ["approved", "published", "archived"]) {
        expect(await denied(go(run, d, to, NOTE, ALL_CHECKS)), `draft->${to}`).toContain("INVALID_TRANSITION");
      }
      const p = await publish(run, { slug: "t2" });
      await as(run, ADM());
      for (const to of ["draft", "pending_review", "approved"]) {
        expect(await denied(go(run, p, to, NOTE, ALL_CHECKS)), `published->${to}`).toContain("INVALID_TRANSITION");
      }
      expect(await denied(run(`select public.mg_content_revise('${d}')`))).toContain("only published or archived");
    });
  });

  test("a revision can only be started once", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const v1 = await publish(run, { slug: "adit" });
      await as(run, SUP());
      await run(`select public.mg_content_revise('${v1}')`);
      expect(await denied(run(`select public.mg_content_revise('${v1}')`))).toContain("already in progress");
    });
  });
});

describe("0051: who may do what", () => {
  test("inspectors, operators, public users and guests have no content permissions at all", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const id = await publish(run, { slug: "adit" });
      for (const [uid, anon] of [[f.county, false], [f.opA, false], [PUB, false], [ANON, true]] as const) {
        await back(run);
        await as(run, uid, anon);
        expect(await denied(save(run, { slug: "x-term" }))).toContain("FORBIDDEN");
        expect(await denied(go(run, id, "archived", "an attempt to withdraw it"))).toMatch(/FORBIDDEN|permission/);
        expect(await denied(run(`select public.mg_content_revise('${id}')`))).toContain("FORBIDDEN");
        expect(await denied(run("select * from public.mg_content_list()"))).toContain("FORBIDDEN");
        expect(await denied(run(`select public.mg_content_get('${id}')`))).toContain("FORBIDDEN");
      }
    });
    await withRole("anon", null, async (run) => {
      expect(await denied(save(run, { slug: "x-term" }))).toMatch(/permission denied/i);
      expect(await denied(run("select * from public.mg_content_list()"))).toMatch(/permission denied/i);
    });
  });

  test("the staff list shows names and provenance but never the body; get shows the full history", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await publish(run, { slug: "adit", title: "Adit" });
      await as(run, SUP());
      const rows = await run("select * from public.mg_content_list()");
      expect(rows.length).toBe(1);
      expect(Object.keys(rows[0])).not.toContain("body");
      expect(rows[0].status).toBe("published");
      expect(typeof rows[0].author_name === "string" || rows[0].author_name === null).toBe(true);
    });
  });
});

describe("0051: validation", () => {
  test("statistics must be well-formed figures; other kinds carry none", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, SUP());
      const stat = (data: string | null, slug = "stats-ok") => save(run, { kind: "statistics", slug, title: "Public figures", body: "", category: null, data });
      expect(await denied(stat(null))).toMatch(/list of figures/);
      expect(await denied(stat(`'{"items":[]}'::jsonb`))).toMatch(/1 to 12/);
      expect(await denied(stat(`'{"items":[{"label":"x","value":5,"as_of":"2026-01-01"}]}'::jsonb`))).toMatch(/label/);
      expect(await denied(stat(`'{"items":[{"label":"Reports received","value":-5,"as_of":"2026-01-01"}]}'::jsonb`))).toMatch(/number between/);
      expect(await denied(stat(`'{"items":[{"label":"Reports received","value":"12","as_of":"2026-01-01"}]}'::jsonb`))).toMatch(/number between/);
      expect(await denied(stat(`'{"items":[{"label":"Reports received","value":12,"as_of":"yesterday"}]}'::jsonb`))).toMatch(/as-of date/);
      await stat(`'{"items":[{"label":"Reports received","value":12,"as_of":"2026-10-31"}]}'::jsonb`);
      expect(await denied(save(run, { slug: "with-data", data: `'{"items":[]}'::jsonb` }))).toMatch(/only statistics/);
    });
  });

  test("text rules, slug rules, dates, and the kind of a draft cannot change", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, SUP());
      expect(await denied(save(run, { slug: "no-category", category: null }))).toMatch(/category/);
      expect(await denied(save(run, { slug: "short", body: "tiny" }))).toMatch(/definition/);
      expect(await denied(save(run, { kind: "safety_guidance", slug: "sg", body: "too short" }))).toMatch(/20 characters/);
      expect(await denied(save(run, { kind: "announcement", slug: "an", body: "short" }))).toMatch(/10 characters/);
      expect(await denied(save(run, { slug: "Bad Slug!" }))).toMatch(/check constraint|public_content_slug_check|violates/i);
      expect(await denied(save(run, { slug: "dates", publishAt: "2030-01-02T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z" }))).toMatch(/expiry must be after/);
      const id = await save(run, { slug: "kind-lock" });
      expect(await denied(save(run, { id, kind: "announcement", slug: "kind-lock", body: "An announcement body text." }))).toMatch(/kind of a draft/);
      expect(await denied(save(run, { slug: "kind-lock" }))).toMatch(/duplicate|unique/i);
    });
  });
});

describe("0051: the glossary is prepared as drafts and nothing is published", () => {
  const SEED = () => read("supabase/seeds/public_glossary_drafts.sql");
  // the seed carries its own begin/commit; inside a test transaction run only its statements
  const loadSeed = async () => (await getDb()).exec(SEED().replace(/^(begin|commit);$/gm, ""));

  test("the seed loads every term as a draft, marked not reviewed, invisible to the public, idempotent", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await loadSeed();
      const n = (await run("select count(*)::int as n, count(*) filter (where status = 'draft')::int as drafts, count(*) filter (where source ilike '%no qualified sign-off%')::int as unreviewed from public.public_content where kind = 'glossary_term'"))[0];
      expect(n.n).toBeGreaterThanOrEqual(200);
      expect(n.drafts).toBe(n.n);
      expect(n.unreviewed).toBe(n.n);
      expect((await run("select count(*)::int as n from public.public_content_events where action = 'import'"))[0].n).toBe(n.n);
      await loadSeed();
      expect((await run("select count(*)::int as n from public.public_content where kind = 'glossary_term'"))[0].n).toBe(n.n);
      expect((await run("select count(*)::int as n from public.public_content_events where action = 'import'"))[0].n).toBe(n.n);
      for (const setup of [() => run("set local role anon"), () => as(run, PUB), () => as(run, ANON, true)]) {
        await back(run);
        await setup();
        expect((await run("select count(*)::int as n from public.public_content"))[0].n).toBe(0);
      }
    });
  });

  test("an imported draft follows the same lifecycle: no human author, so any reviewer reviews it; only an administrator publishes it", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await loadSeed();
      const id = (await run("select id from public.public_content where slug = 'adit' and kind = 'glossary_term'"))[0].id as string;
      await as(run, SUP());
      await go(run, id, "pending_review");
      await go(run, id, "approved", NOTE, ALL_CHECKS); // imported rows have no human author: any reviewer may review
      await back(run);
      await as(run, ADM());
      const d = (await run(`select public.mg_content_get('${id}') as d`))[0].d as { events: { actor: string }[] };
      expect(d.events[0].actor).toBe("System import");
      await go(run, id, "published");
      await back(run);
      await run("set local role anon");
      expect((await visible(run)).map((r) => r.slug)).toEqual(["adit"]);
    });
  });

  test("the committed seed matches the glossary source, and nothing French is claimed", async () => {
    const proc = Bun.spawnSync(["node", "scripts/gen-public-glossary-seed.mjs", "--check"], { cwd: ROOT });
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
    expect(SEED()).not.toMatch(/'fr'/);
    expect(SEED()).not.toMatch(/insert into public\.public_content[^;]*'published'/);
  });
});

describe("0051: live anonymous statistics are retired", () => {
  test("anonymous callers cannot read meta; staff still can; non-staff signed-in users cannot", async () => {
    await withRole("anon", null, async (run) => {
      expect(await denied(run("select * from public.meta"))).toMatch(/permission denied/i);
    });
    await withRole("authenticated", { sub: f.admin, role: "authenticated" }, async (run) => {
      expect((await run("select * from public.meta")).length).toBeGreaterThan(0);
    });
    await withRole("authenticated", { sub: f.opA, role: "authenticated" }, async (run) => {
      expect((await run("select * from public.meta")).length).toBe(0);
    });
    await withRole("authenticated", { sub: f.guest, role: "authenticated" }, async (run) => {
      expect((await run("select * from public.meta")).length).toBe(0);
    });
  });

  test("approved statistics are what the public sees", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await publish(run, {
        kind: "statistics",
        slug: "q3-figures",
        title: "Third-quarter figures",
        body: "",
        category: null,
        data: `'{"items":[{"label":"Reports received","value":12,"as_of":"2026-09-30"}]}'::jsonb`,
      });
      await run("set local role anon");
      const rows = await run("select data from public.public_content where kind = 'statistics'");
      expect(rows.length).toBe(1);
      expect((rows[0].data as { items: { value: number }[] }).items[0].value).toBe(12);
    });
  });
});

describe("0051: existing roles are unaffected", () => {
  test("operators, inspectors and supervisors keep their access; reports and feedback still work", async () => {
    await withRole("authenticated", { sub: f.opA, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
    });
    await withRole("authenticated", { sub: f.county, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
    });
    await withRole("authenticated", { sub: f.national, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.sites")).length).toBe(2);
      await run("select * from public.mg_feedback_queue()");
    });
    await withRole("authenticated", { sub: f.admin, role: "authenticated" }, async (run) => {
      expect((await run("select id from public.profiles")).length).toBeGreaterThan(3);
    });
  });
});

describe("0051: source contracts", () => {
  test("public pages render content as plain text — no raw HTML anywhere", () => {
    for (const p of [
      "src/components/ContentText.tsx",
      "src/pages/public/PublicHub.tsx",
      "src/pages/public/PublicGlossary.tsx",
      "src/pages/public/PublicSafety.tsx",
      "src/pages/public/PublicNotices.tsx",
      "src/components/ApprovedStatistics.tsx",
      "src/pages/ContentAdmin.tsx",
    ]) {
      const code = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      expect(code, p).not.toMatch(/dangerouslySetInnerHTML|innerHTML|marked\(|markdown/i);
    }
  });
  test("the client no longer reads live statistics; the landing page shows approved ones", () => {
    const b = read("src/lib/backend.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(b).not.toMatch(/stats:\s*\{[\s\S]{0,40}publicStats|publicStats:\s*\(\)|from\("meta"\)/);
    expect(b).not.toMatch(/rpc\("refresh_public_stats"/);
    const l = read("src/pages/Landing.tsx");
    expect(l).not.toMatch(/publicStats|Registered mining sites|Documented incidents/);
    expect(l).toContain("ApprovedStatistics");
  });
  test("public users and guests are routed to their own area, never to a staff gate", () => {
    const r = read("src/components/RequireAuth.tsx");
    expect(r).toMatch(/anonymous_guest"\) return <Navigate to="\/public"/);
    expect(r).toMatch(/Navigate to="\/account"/);
    const m = read("src/main.tsx");
    expect(m).toContain('path="/public/glossary"');
    expect(m).toContain('path="content"');
  });
  test("the migration grants no table writes, no anon function access, and publishes nothing", () => {
    const m = read("supabase/migrations/0051_public_content.sql").replace(/--[^\n]*/g, "");
    expect(m).not.toMatch(/\bgrant\s+(insert|update|delete|all)\b/i);
    expect(m).not.toMatch(/grant execute[^;]*to anon/i);
    expect(m).not.toMatch(/'published'\s*,\s*now\(\)/);
  });
});
