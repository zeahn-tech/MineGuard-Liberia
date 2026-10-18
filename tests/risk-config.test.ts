// ---------------------------------------------------------------------------
// SESSION 7 — CONFIGURABLE RISK ENGINE (RSK-1, RSK-2), database level.
//
// Acceptance, each mapped to a block below:
//   (1) "score ≡ sum of factors holds under any config"
//         -> mg_risk_build property test over seeded-random counts × weights,
//            and mg_risk_scores / mg_risk_explanation over many PUBLISHED
//            random configs on the real seeded sites; plus an independent
//            re-computation of the score from the row's own counts.
//   (2) "old scores reproducible by version"
//         -> a recorded set of scores is byte-identical when recomputed under
//            its version after newer versions are published; as_of selects the
//            version in force; the explainer agrees.
//   RSK-1 controls: admin-only publish, append-only, validated, effective-dated,
//            server-owned columns, exactly one audit row per publish.
//   RSK-2: historical-compliance factor (late-closed corrective actions,
//            look-back window), cite-or-abstain ids, explainer ≡ scores.
//
// Everything runs through withRole(): each case is its own transaction that is
// ALWAYS rolled back, so the shared database keeps version 1 only.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getFixture,
  IDS,
  withRole,
  type Row,
  type Runner,
} from "./helpers/pglite-db";
import {
  LEGACY_RISK_CONFIG,
  RISK_WEIGHT_KEYS,
  diffRiskSettings,
  validateRiskSettings,
  versionHistory,
  versionInForce,
  type RiskConfigVersion,
  type RiskWeights,
} from "../src/lib/risk-config";
import { factorsFromBuilt, factorsFromCounts, RISK_WEIGHTS } from "../src/lib/risk-model";

beforeAll(() => getFixture());

const ADMIN = { sub: IDS.admin, role: "authenticated" };

function asRole<T>(uid: string, fn: (run: Runner) => Promise<T>) {
  return withRole("authenticated", { sub: uid, role: "authenticated" }, fn);
}
const asAdmin = <T>(fn: (run: Runner) => Promise<T>) => withRole("authenticated", ADMIN, fn);

// -- deterministic PRNG (mulberry32) so a failure is reproducible ------------
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

function randomWeights(r: () => number): RiskWeights {
  const w = {} as RiskWeights;
  for (const k of RISK_WEIGHT_KEYS) w[k] = r() < 0.15 ? 0 : randInt(r, 0, 60);
  return w;
}

type Counts = {
  findingsTotal: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  overdueCAs: number;
  lateClosedCAs: number;
  fatalityIncidents: number;
  seriousIncidents: number;
  envAlerts: number;
};

/** The score, from first principles — deliberately NOT the builder under test. */
function expectedScore(c: Counts, w: RiskWeights): number {
  return (
    c.criticalFindings * w.criticalFinding +
    c.highFindings * w.highFinding +
    c.mediumFindings * w.mediumFinding +
    c.lowFindings * w.lowFinding +
    (c.findingsTotal > 3 ? w.repeatFinding * Math.floor(c.findingsTotal / 4) : 0) +
    c.overdueCAs * w.overdueCA +
    c.fatalityIncidents * w.fatality +
    c.seriousIncidents * w.seriousIncident +
    c.envAlerts * w.envAlert +
    c.lateClosedCAs * w.lateClosedCA
  );
}

async function publish(
  run: Runner,
  weights: RiskWeights,
  opts: { lookbackDays?: number; effectiveFrom?: string; note?: string } = {},
): Promise<Row> {
  const rows = await run(
    `insert into public.risk_config_versions
       (weights, historical_lookback_days, effective_from, change_note)
     values ($1::jsonb, $2, coalesce($3::timestamptz, now()), $4)
     returning *`,
    [JSON.stringify(weights), opts.lookbackDays ?? 365, opts.effectiveFrom ?? null, opts.note ?? "test publish"],
  );
  return rows[0];
}

async function scores(run: Runner, version?: number, asOf?: string): Promise<Row[]> {
  const rows = await run(
    `select s as j
       from public.mg_risk_scores($1::integer, $2::timestamptz) s`,
    [version ?? null, asOf ?? null],
  );
  return rows.map((r) => r.j as Row);
}

const bySite = (rows: Row[]) => Object.fromEntries(rows.map((r) => [String(r.siteId), r]));

// ===========================================================================
describe("RSK-1: version 1 reproduces the pre-Session-7 weights", () => {
  test("seeded version 1 = legacy weights, historical compliance off", async () => {
    await asAdmin(async (run) => {
      const rows = await run(`select * from public.risk_config_versions order by version`);
      expect(rows.length).toBe(1);
      expect(rows[0].version).toBe(1);
      expect(rows[0].weights).toEqual(LEGACY_RISK_CONFIG.weights);
      expect(rows[0].weights).toMatchObject(RISK_WEIGHTS);
      expect((rows[0].weights as RiskWeights).lateClosedCA).toBe(0);
      expect(rows[0].created_by).toBeNull(); // system seed
    });
  });

  test("under version 1 the database score equals the legacy client model for every site", async () => {
    await asAdmin(async (run) => {
      for (const row of await scores(run)) {
        const counts = {
          findingsTotal: Number(row.findingsTotal),
          low: Number(row.lowFindings),
          medium: Number(row.mediumFindings),
          high: Number(row.highFindings),
          critical: Number(row.criticalFindings),
          overdueCAs: Number(row.overdueCAs),
          fatalityIncidents: Number(row.fatalityIncidents),
          seriousIncidents: Number(row.seriousIncidents),
          envAlerts: Number(row.envAlerts),
          lateClosedCAs: Number(row.lateClosedCAs),
        };
        const legacy = factorsFromCounts(counts);
        expect(row.score).toBe(legacy.score);
        const built = factorsFromBuilt({ score: row.score, factors: row.factors });
        expect(built.factors).toEqual(legacy.factors);
        expect(row.configVersion).toBe(1);
      }
    });
  });
});

// ===========================================================================
describe("RSK-1: admin-only, append-only, validated, effective-dated, audited", () => {
  const good = { ...LEGACY_RISK_CONFIG.weights, highFinding: 7 };

  test("an administrator publishes; the server assigns version, author and time", async () => {
    await asAdmin(async (run) => {
      const spoof = await run(
        `insert into public.risk_config_versions
           (version, weights, effective_from, change_note, created_by, created_at)
         values (99, $1::jsonb, now(), 'spoof attempt', '${IDS.opA}', '2001-01-01')
         returning version, created_by, created_at`,
        [JSON.stringify(good)],
      );
      expect(spoof[0].version).toBe(2); // not 99
      expect(spoof[0].created_by).toBe(IDS.admin); // not opA
      expect(new Date(String(spoof[0].created_at)).getFullYear()).toBeGreaterThan(2020);
    });
  });

  test("every other role — and anon — is refused", async () => {
    const attempt = (run: Runner) => publish(run, good);
    for (const [name, uid] of [
      ["supervisor", IDS.national],
      ["inspector", IDS.county],
      ["operator", IDS.opA],
      ["role-less", IDS.guest],
    ] as const) {
      let msg = "";
      await asRole(uid, async (run) => {
        try {
          await attempt(run);
        } catch (e) {
          msg = e instanceof Error ? e.message : String(e);
        }
      });
      expect(msg, name).toMatch(/FORBIDDEN|row-level security|permission denied/);
    }
    let anonMsg = "";
    await withRole("anon", null, async (run) => {
      try {
        await attempt(run);
      } catch (e) {
        anonMsg = e instanceof Error ? e.message : String(e);
      }
    });
    expect(anonMsg).toMatch(/permission denied/);
  });

  test("any signed-in role may READ the config; anon and role-less may not", async () => {
    for (const uid of [IDS.admin, IDS.national, IDS.county, IDS.opA]) {
      await asRole(uid, async (run) => {
        expect((await run(`select 1 from public.risk_config_versions`)).length).toBe(1);
      });
    }
    await asRole(IDS.guest, async (run) => {
      expect((await run(`select 1 from public.risk_config_versions`)).length).toBe(0);
    });
    await withRole("anon", null, async (run) => {
      await expect(run(`select 1 from public.risk_config_versions`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  test("append-only: nobody can UPDATE or DELETE a version — not even the admin or the owner", async () => {
    // A client write is either refused outright (no grant) or matches ZERO
    // rows (no UPDATE/DELETE policy — what remains if another suite re-ran
    // 0002's blanket grants). Either way the row must be untouched.
    const refusedOrNoEffect = async (run: Runner, sql: string) => {
      try {
        expect((await run(sql)).length).toBe(0);
      } catch (e) {
        expect(String(e instanceof Error ? e.message : e)).toMatch(/permission denied|IMMUTABLE/);
        throw e; // aborts this transaction; caller re-enters a fresh one
      }
    };
    for (const sql of [
      `update public.risk_config_versions set change_note = 'rewritten' where version = 1 returning 1`,
      `delete from public.risk_config_versions where version = 1 returning 1`,
    ]) {
      await asAdmin(async (run) => {
        await refusedOrNoEffect(run, sql).catch(() => {});
      });
    }
    await asAdmin(async (run) => {
      const rows = await run(`select change_note from public.risk_config_versions where version = 1`);
      expect(String(rows[0].change_note)).toMatch(/^Initial configuration/);
    });
    // The owner bypasses grants and RLS but not the trigger.
    await withRole("postgres", null, async (run) => {
      await expect(
        run(`update public.risk_config_versions set change_note = 'x' where version = 1`),
      ).rejects.toThrow(/IMMUTABLE/);
      await expect(run(`delete from public.risk_config_versions where version = 1`)).rejects.toThrow(
        /IMMUTABLE/,
      );
    });
  });

  test("weights are validated: exact key set, integers 0..1000", async () => {
    const bad: Record<string, unknown>[] = [
      { ...good, extraKey: 1 },
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== "envAlert")),
      { ...good, highFinding: -1 },
      { ...good, highFinding: 1001 },
      { ...good, highFinding: 2.5 },
      { ...good, highFinding: "6" },
      { ...good, highFinding: null },
    ];
    for (const w of bad) {
      await asAdmin(async (run) => {
        await expect(
          run(
            `insert into public.risk_config_versions (weights, effective_from, change_note)
             values ($1::jsonb, now(), 'bad')`,
            [JSON.stringify(w)],
          ),
        ).rejects.toThrow(/INVALID_RISK_CONFIG/);
      });
    }
    // 10.0 is an integer value and is accepted.
    await asAdmin(async (run) => {
      await run(
        `insert into public.risk_config_versions (weights, effective_from, change_note)
         values ($1::jsonb, now(), 'okay')`,
        [JSON.stringify({ ...good, highFinding: 10.0 }).replace('"highFinding":10', '"highFinding":10.0')],
      );
    });
    // lookback + note CHECKs
    await asAdmin(async (run) => {
      await expect(publish(run, good, { lookbackDays: 0 })).rejects.toThrow();
      await expect(publish(run, good, { lookbackDays: 4000 })).rejects.toThrow();
      await expect(publish(run, good, { note: " x " })).rejects.toThrow();
    });
  });

  test("effective dating: never in the past, strictly after every earlier version", async () => {
    await asAdmin(async (run) => {
      await expect(
        publish(run, good, { effectiveFrom: "2020-01-01T00:00:00Z" }),
      ).rejects.toThrow(/INVALID_EFFECTIVE_DATE/);
    });
    await asAdmin(async (run) => {
      const v2 = await publish(run, good, { effectiveFrom: new Date(Date.now() + 5 * 86_400_000).toISOString() });
      expect(v2.version).toBe(2);
      // earlier than (and equal to) the latest version's date is refused…
      await expect(
        publish(run, good, { effectiveFrom: new Date(Date.now() + 2 * 86_400_000).toISOString() }),
      ).rejects.toThrow(/INVALID_EFFECTIVE_DATE/);
    });
    await asAdmin(async (run) => {
      const t = new Date(Date.now() + 5 * 86_400_000).toISOString();
      await publish(run, good, { effectiveFrom: t });
      await expect(publish(run, good, { effectiveFrom: t })).rejects.toThrow(/INVALID_EFFECTIVE_DATE/);
      // …later is fine and numbered next
      const v3 = await publish(run, good, { effectiveFrom: new Date(Date.now() + 9 * 86_400_000).toISOString() });
      expect(v3.version).toBe(3);
    });
  });

  test("a future-dated version does not apply until its date; as_of picks the version in force", async () => {
    await asAdmin(async (run) => {
      const at = new Date(Date.now() + 10 * 86_400_000);
      await publish(run, { ...good, highFinding: 40 }, { effectiveFrom: at.toISOString() });
      const now = (await scores(run)).find((r) => Number(r.highFindings) > 0)!;
      expect(now.configVersion).toBe(1);
      const before = new Date(at.getTime() - 1000).toISOString();
      expect((await scores(run, undefined, before)).every((r) => r.configVersion === 1)).toBe(true);
      const after = (await scores(run, undefined, at.toISOString())).find(
        (r) => r.siteId === now.siteId,
      )!;
      expect(after.configVersion).toBe(2);
      expect(after.score).not.toBe(now.score);
    });
  });

  test("exactly one server-written audit row per publish, attributed to the session", async () => {
    await asAdmin(async (run) => {
      const before = Number(
        (await run(`select count(*) as n from public.audit_log where entity_type = 'risk_config_versions'`))[0].n,
      );
      await publish(run, good, { note: "raise high-finding weight" });
      const rows = await run(
        `select actor_id, action, details from public.audit_log
          where entity_type = 'risk_config_versions' order by created_at`,
      );
      expect(rows.length).toBe(before + 1);
      const last = rows[rows.length - 1];
      expect(last.actor_id).toBe(IDS.admin);
      expect(last.action).toBe("risk_config_versions.insert");
      const after = (last.details as { after: Row }).after;
      expect((after.weights as RiskWeights).highFinding).toBe(7);
      expect(after.change_note).toBe("raise high-finding weight");
    });
  });

  test("the client mirror refuses what the database refuses", () => {
    expect(validateRiskSettings(LEGACY_RISK_CONFIG)).toBeNull();
    expect(validateRiskSettings({ weights: { ...LEGACY_RISK_CONFIG.weights, highFinding: -1 }, lookbackDays: 30 })).toMatch(/between/);
    expect(validateRiskSettings({ weights: { ...LEGACY_RISK_CONFIG.weights, highFinding: 1.5 }, lookbackDays: 30 })).toMatch(/whole/);
    expect(validateRiskSettings({ weights: { ...LEGACY_RISK_CONFIG.weights, nope: 1 }, lookbackDays: 30 })).toMatch(/Unknown/);
    expect(validateRiskSettings({ weights: LEGACY_RISK_CONFIG.weights, lookbackDays: 0 })).toMatch(/Look-back/);
  });
});

// ===========================================================================
describe("RSK-2 acceptance (1): score ≡ Σ factor points under ANY config", () => {
  test("mg_risk_build: 400 random counts × weights — score = Σ points, and equals the first-principles total", async () => {
    const r = prng(0x5eed7);
    await asAdmin(async (run) => {
      for (let i = 0; i < 400; i++) {
        const counts: Counts = {
          findingsTotal: 0,
          criticalFindings: randInt(r, 0, 6),
          highFindings: randInt(r, 0, 6),
          mediumFindings: randInt(r, 0, 9),
          lowFindings: randInt(r, 0, 9),
          overdueCAs: randInt(r, 0, 5),
          lateClosedCAs: randInt(r, 0, 5),
          fatalityIncidents: randInt(r, 0, 3),
          seriousIncidents: randInt(r, 0, 4),
          envAlerts: randInt(r, 0, 4),
        };
        counts.findingsTotal =
          counts.criticalFindings + counts.highFindings + counts.mediumFindings + counts.lowFindings;
        const weights = randomWeights(r);
        const out = (
          await run(`select public.mg_risk_build($1::jsonb, $2::jsonb, 90) as b`, [
            JSON.stringify(counts),
            JSON.stringify(weights),
          ])
        )[0].b as { score: number; factors: { key: string; label: string; points: number }[] };

        const sum = out.factors.reduce((n, f) => n + f.points, 0);
        expect(out.score).toBe(sum); // the identity
        expect(out.score).toBe(expectedScore(counts, weights)); // and it is the right number
        expect(out.factors.every((f) => f.points > 0)).toBe(true); // zero factors never materialize

        // TS fallback builder = SQL builder (same labels, points, order)
        const ts = factorsFromCounts(
          {
            findingsTotal: counts.findingsTotal,
            critical: counts.criticalFindings,
            high: counts.highFindings,
            medium: counts.mediumFindings,
            low: counts.lowFindings,
            overdueCAs: counts.overdueCAs,
            lateClosedCAs: counts.lateClosedCAs,
            fatalityIncidents: counts.fatalityIncidents,
            seriousIncidents: counts.seriousIncidents,
            envAlerts: counts.envAlerts,
          },
          { weights, lookbackDays: 90 },
        );
        expect(ts.score).toBe(out.score);
        expect(ts.factors.map((f) => [f.label, f.points])).toEqual(
          out.factors.map((f) => [f.label, f.points]),
        );
      }
    });
  });

  test("mg_risk_scores + mg_risk_explanation on the real seeded sites under 30 published random configs", async () => {
    const r = prng(0xc0ffee);
    await asAdmin(async (run) => {
      // Give the seeded sites some historical-compliance inputs so the new
      // factor is exercised by the random weights, too.
      await seedLateClosed(run);
      for (let i = 0; i < 30; i++) {
        const w = randomWeights(r);
        const lookback = [7, 30, 90, 365][i % 4];
        const v = await publish(run, w, {
          lookbackDays: lookback,
          effectiveFrom: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
        });
        const version = Number(v.version);
        for (const row of await scores(run, version)) {
          const sum = (row.factors as { points: number }[]).reduce((n, f) => n + f.points, 0);
          expect(row.score, `v${version}`).toBe(sum);
          expect(row.score, `v${version}`).toBe(
            expectedScore(
              {
                findingsTotal: Number(row.findingsTotal),
                criticalFindings: Number(row.criticalFindings),
                highFindings: Number(row.highFindings),
                mediumFindings: Number(row.mediumFindings),
                lowFindings: Number(row.lowFindings),
                overdueCAs: Number(row.overdueCAs),
                lateClosedCAs: Number(row.lateClosedCAs),
                fatalityIncidents: Number(row.fatalityIncidents),
                seriousIncidents: Number(row.seriousIncidents),
                envAlerts: Number(row.envAlerts),
              },
              w,
            ),
          );
          expect(row.configVersion).toBe(version);

          // the explainer reads the SAME config: identical score and factors
          const ex = (
            await run(`select public.mg_risk_explanation($1::uuid, $2::integer, null) as e`, [
              row.siteId,
              version,
            ])
          )[0].e as Row;
          expect(ex.score, `explainer v${version}`).toBe(row.score);
          expect(ex.factors).toEqual(row.factors);
          expect(ex.configVersion).toBe(version);
        }
      }
    });
  });
});

// ===========================================================================
describe("RSK-2 acceptance (2): old scores reproducible by version", () => {
  test("a recorded score set is byte-identical when recomputed under its version after newer versions land", async () => {
    await asAdmin(async (run) => {
      const recorded = await scores(run); // in force: v1
      expect(recorded.every((r) => r.configVersion === 1)).toBe(true);
      const recordedJson = JSON.stringify(recorded);

      await publish(run, { ...LEGACY_RISK_CONFIG.weights, highFinding: 25, overdueCA: 30 }, { note: "tighten" });
      await publish(run, { ...LEGACY_RISK_CONFIG.weights, criticalFinding: 50, lateClosedCA: 9 }, {
        note: "again",
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const nowScores = await scores(run);
      expect(nowScores.every((r) => r.configVersion === 2)).toBe(true);
      expect(JSON.stringify(nowScores)).not.toBe(recordedJson); // the config really changed the numbers

      // …but version 1, asked for by number, is exactly what was recorded.
      expect(JSON.stringify(await scores(run, 1))).toBe(recordedJson);
      // …and by date: any moment before v2 took effect resolves to v1.
      const t0 = new Date(Date.now() - 3600_000).toISOString();
      expect(JSON.stringify(await scores(run, undefined, t0))).toBe(recordedJson);
    });
  });

  test("an unknown version is an error, never a silent fallback", async () => {
    await asAdmin(async (run) => {
      await expect(scores(run, 42)).rejects.toThrow(/RISK_CONFIG_NOT_FOUND/);
      await expect(
        run(`select public.mg_risk_explanation('${IDS.siteA}'::uuid, 42, null)`),
      ).rejects.toThrow(/RISK_CONFIG_NOT_FOUND/);
    });
  });

  test("the history view: diffs between consecutive versions and the version in force", () => {
    const mk = (version: number, effectiveFrom: number, over: Partial<RiskWeights>, lb = 365): RiskConfigVersion => ({
      id: `id${version}`,
      version,
      weights: { ...LEGACY_RISK_CONFIG.weights, ...over },
      lookbackDays: lb,
      effectiveFrom,
      changeNote: `n${version}`,
      createdBy: null,
      createdAt: effectiveFrom,
    });
    const vs = [mk(1, 0, {}), mk(2, 1000, { highFinding: 9, lateClosedCA: 2 }), mk(3, 2000, { highFinding: 9, lateClosedCA: 2 }, 90)];
    const hist = versionHistory(vs);
    expect(hist.map((h) => h.version.version)).toEqual([3, 2, 1]); // newest first
    expect(hist[2].changes).toBeNull();
    expect(hist[1].changes!.map((c) => [c.key, c.from, c.to])).toEqual([
      ["highFinding", 6, 9],
      ["lateClosedCA", 0, 2],
    ]);
    expect(hist[0].changes!.map((c) => [c.key, c.from, c.to])).toEqual([["lookbackDays", 365, 90]]);
    expect(diffRiskSettings(vs[1], vs[1])).toEqual([]);
    expect(versionInForce(vs, 999)!.version).toBe(1);
    expect(versionInForce(vs, 1000)!.version).toBe(2);
    expect(versionInForce(vs, 5000)!.version).toBe(3);
    expect(versionInForce(vs, -1)).toBeNull();
  });
});

// ===========================================================================
/** Late-closed history for site A: one closed LATE inside 30 days, one closed
 *  late 100 days ago, one closed ON TIME, plus an open (not closed) one. */
async function seedLateClosed(run: Runner) {
  const ins = (desc: string, due: string, closed: string | null, status: string) =>
    run(
      `insert into public.corrective_actions
         (finding_id, site_id, description, due_at, opened_by_id, status, closed_at)
       values ('${IDS.findingA}', '${IDS.siteA}', $1, now() + $2::interval, '${IDS.admin}', $4, now() + $3::interval)
       returning id`,
      [desc, due, closed, status],
    );
  const late10 = (await ins("closed late (10d ago)", "-20 days", "-10 days", "closed"))[0].id;
  const late100 = (await ins("closed late (100d ago)", "-120 days", "-100 days", "closed"))[0].id;
  const onTime = (await ins("closed on time", "-10 days", "-15 days", "closed"))[0].id;
  return { late10: String(late10), late100: String(late100), onTime: String(onTime) };
}

describe("RSK-2: historical-compliance factor", () => {
  test("off by default (weight 0): version 1 scores are unchanged by late-closed history", async () => {
    await asAdmin(async (run) => {
      const before = bySite(await scores(run))[IDS.siteA];
      await seedLateClosed(run);
      const after = bySite(await scores(run))[IDS.siteA];
      expect(Number(after.lateClosedCAs)).toBe(2); // counted (default look-back 365d)…
      expect(after.score).toBe(before.score); // …but weightless
      expect((after.factors as { label: string }[]).some((f) => /closed late/.test(f.label))).toBe(false);
    });
  });

  test("on (weight > 0): counts only closed-after-due within the look-back, ignores on-time and not-yet-closed", async () => {
    await asAdmin(async (run) => {
      const ids = await seedLateClosed(run);
      const base = bySite(await scores(run))[IDS.siteA];

      // 365-day look-back: both late closures count (10d and 100d ago)
      const v2 = await publish(run, { ...LEGACY_RISK_CONFIG.weights, lateClosedCA: 3 }, { lookbackDays: 365 });
      const wide = bySite(await scores(run, Number(v2.version)))[IDS.siteA];
      expect(wide.score).toBe(Number(base.score) + 2 * 3);
      expect(wide.factors).toContainEqual({
        key: "lateClosedCAs",
        label: "2 corrective action(s) closed late in the last 365 days",
        points: 6,
      });

      // 30-day look-back: only the 10-day-old closure counts
      const v3 = await publish(run, { ...LEGACY_RISK_CONFIG.weights, lateClosedCA: 3 }, {
        lookbackDays: 30,
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const narrow = bySite(await scores(run, Number(v3.version)))[IDS.siteA];
      expect(narrow.score).toBe(Number(base.score) + 3);

      // cite-or-abstain: the explainer cites exactly the record that grounds it
      const ex = (
        await run(`select public.mg_risk_explanation('${IDS.siteA}'::uuid, $1::integer, null) as e`, [
          Number(v3.version),
        ])
      )[0].e as Row;
      expect(ex.lateClosedCaIds).toEqual([ids.late10]);
      const built = factorsFromBuilt(
        { score: ex.score, factors: ex.factors },
        { lateClosedCaIds: ex.lateClosedCaIds as string[] },
      );
      const lateFactor = built.factors.find((f) => /closed late/.test(f.label))!;
      expect(lateFactor.recordIds).toEqual([ids.late10]);
      expect(ids.onTime).not.toBe(ids.late10);
    });
  });

  test("the client fallback model agrees with the database on the historical factor", async () => {
    await asAdmin(async (run) => {
      await seedLateClosed(run);
      const v = await publish(run, { ...LEGACY_RISK_CONFIG.weights, lateClosedCA: 4 }, { lookbackDays: 120 });
      const row = bySite(await scores(run, Number(v.version)))[IDS.siteA];
      const ts = factorsFromCounts(
        {
          findingsTotal: Number(row.findingsTotal),
          low: Number(row.lowFindings),
          medium: Number(row.mediumFindings),
          high: Number(row.highFindings),
          critical: Number(row.criticalFindings),
          overdueCAs: Number(row.overdueCAs),
          fatalityIncidents: Number(row.fatalityIncidents),
          seriousIncidents: Number(row.seriousIncidents),
          envAlerts: Number(row.envAlerts),
          lateClosedCAs: Number(row.lateClosedCAs),
        },
        { weights: v.weights as RiskWeights, lookbackDays: 120 },
      );
      expect(ts.score).toBe(row.score);
    });
  });
});

// ===========================================================================
describe("RSK-2: server-side computation stays inside the caller's scope", () => {
  test("operators score only their own tenant; role-less accounts get nothing; anon cannot execute", async () => {
    await asRole(IDS.opA, async (run) => {
      const rows = await scores(run);
      expect(rows.map((r) => r.siteId)).toEqual([IDS.siteA]);
      const ex = (await run(`select public.mg_risk_explanation('${IDS.siteB}'::uuid, null, null) as e`))[0].e;
      expect(ex).toBeNull(); // cross-tenant site null-masks
    });
    await asAdmin(async (run) => {
      expect((await scores(run)).length).toBe(2);
    });
    await asRole(IDS.guest, async (run) => {
      expect(await scores(run)).toEqual([]);
      const ex = (await run(`select public.mg_risk_explanation('${IDS.siteA}'::uuid, null, null) as e`))[0].e;
      expect(ex).toBeNull();
    });
    await withRole("anon", null, async (run) => {
      await expect(scores(run)).rejects.toThrow(/permission denied/);
    });
  });
});

// ===========================================================================
describe("source contracts", () => {
  const ROOT = join(import.meta.dir, "..");
  const backend = readFileSync(join(ROOT, "src/lib/backend.ts"), "utf8");

  test("backend scoring and explainer read the database config — no weight constant is multiplied client-side", () => {
    const start = backend.indexOf("riskScores: (args?");
    const end = backend.indexOf("  // ----------------------------------------------------------- inspections");
    const region = backend.slice(start, end);
    expect(region).toContain('supabase.rpc("mg_risk_scores"');
    expect(region).toContain('supabase.rpc("mg_risk_explanation"');
    expect(region).not.toContain("RISK_WEIGHTS");
    expect(backend).not.toMatch(/RISK_WEIGHTS\./);
  });

  test("the config UI never imports the legacy constants as a source of truth", () => {
    const page = readFileSync(join(ROOT, "src/pages/RiskConfig.tsx"), "utf8");
    expect(page).not.toContain("RISK_WEIGHTS");
    expect(page).toContain("api.riskConfig");
  });
});
