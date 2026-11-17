#!/usr/bin/env node
// node scripts/db/diff-fingerprint.mjs <expected.json> <actual.json>
// Compares two schema fingerprints (JSON arrays of {kind,obj,h}). Report-only: prints what differs, always exits 0
// unless an input is unreadable. "expected" is a clean build of the repo's migrations; "actual" is a live database.
import { readFileSync, appendFileSync } from "node:fs";

const EXT = /^(armor|crypt|dearmor|decrypt|digest|encrypt|fips_mode|gen_|gin_|gtrgm|hmac|pgp_|show_|similarity|set_limit|strict_word|word_similarity|pg_stat|uuid_|gist_)/;
const noise = (r) => (r.kind === "constraint" && /_not_null$/.test(r.obj)) || ((r.kind === "function" || r.kind === "func_exec") && EXT.test(r.obj));

export function diffFingerprints(expected, actual) {
  const ex = new Map(expected.filter((r) => !noise(r)).map((r) => [`${r.kind}|${r.obj.slice(0, 63)}`, r.h]));
  const ac = new Map(actual.filter((r) => !noise(r)).map((r) => [`${r.kind}|${r.obj.slice(0, 63)}`, r.h]));
  const out = { equal: 0, differs: [], repoOnly: [], liveOnly: [] };
  for (const [k, h] of ex) { if (!ac.has(k)) out.repoOnly.push(k); else if (ac.get(k) === h) out.equal++; else out.differs.push(k); }
  for (const k of ac.keys()) if (!ex.has(k)) out.liveOnly.push(k);
  return out;
}

/** Split a diff into expected (listed in the accepted-drift file) and unexpected. */
export function classifyDrift(d, accepted = {}) {
  const pick = (list, map) => ({ accepted: list.filter((k) => k in (map ?? {})), unexpected: list.filter((k) => !(k in (map ?? {}))) });
  const differs = pick(d.differs, accepted.differs), repoOnly = pick(d.repoOnly, accepted.repoOnly), liveOnly = pick(d.liveOnly, accepted.liveOnly);
  const unexpected = [...differs.unexpected.map((k) => `DIFFERS ${k}`), ...repoOnly.unexpected.map((k) => `MISSING-LIVE ${k}`), ...liveOnly.unexpected.map((k) => `LIVE-ONLY ${k}`)];
  const acceptedCount = differs.accepted.length + repoOnly.accepted.length + liveOnly.accepted.length;
  return { unexpected, acceptedCount };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const [a, b] = argv;
  const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const ignoreKinds = argv.flatMap((x, i) => (x === "--ignore-kind" ? [argv[i + 1]] : []));
  const strict = argv.includes("--strict");
  const accepted = opt("--accepted") ? JSON.parse(readFileSync(opt("--accepted"), "utf8")) : {};
  const keep = (r) => !ignoreKinds.includes(r.kind);
  const d = diffFingerprints(JSON.parse(readFileSync(a, "utf8")).filter(keep), JSON.parse(readFileSync(b, "utf8")).filter(keep));
  const cls = classifyDrift(d, accepted);
  const lines = [`equal: ${d.equal}`, `differs: ${d.differs.length}`, `in repo build only (missing live): ${d.repoOnly.length}`, `live only (no migration creates it): ${d.liveOnly.length}`];
  for (const [t, l] of [["DIFFERS", d.differs], ["MISSING-LIVE", d.repoOnly], ["LIVE-ONLY", d.liveOnly]]) for (const k of l) lines.push(`  ${t} ${k}`);
  lines.push(`accepted (reviewed, kept on purpose): ${cls.acceptedCount}`, `UNEXPECTED: ${cls.unexpected.length}`);
  for (const u of cls.unexpected) lines.push(`  ${u}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Schema fingerprint: live vs clean build of the repo\n```\n" + lines.join("\n") + "\n```\n");
  if (strict && cls.unexpected.length) { console.error(`::error::${cls.unexpected.length} unexpected schema difference(s); see the list above (add to supabase/checks/accepted-drift.json only after review)`); process.exit(1); }
}
