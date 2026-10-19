// Splits the generated boundary seed into pieces small enough for the Supabase
// SQL editor (which refuses to save snippets near ~1 MB: "request entity too
// large"). Every part is self-contained and idempotent: same guard, same
// not-exists / on-conflict rules, same final verification query.
//   bun scripts/split-boundary-seed.ts [maxBytesPerPart=80000]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const SRC = "supabase/seeds/liberia_boundaries_geoboundaries.sql";
const OUT = "supabase/seeds/split";
const MAX = Number(process.argv[2] ?? 80_000);

const text = readFileSync(SRC, "utf8");
const lines = text.split("\n");
const start = lines.findIndex((l) => l.trim() === "from (values") + 1;
const end = lines.findIndex((l, i) => i > start && l.startsWith("  ) as v("));
const insertAt = lines.findIndex((l) => l.startsWith("insert into public.admin_boundaries"));
if (start <= 0 || end < 0 || insertAt < 0) throw new Error("unexpected seed layout");

const guardEnd = insertAt; // header comment + guard block precede the insert
const header = lines.slice(0, guardEnd).join("\n");
const insertHead = lines.slice(insertAt, start).join("\n");
const tail = lines.slice(end).join("\n");
const rows = lines.slice(start, end).map((r) => r.replace(/,\s*$/, ""));

const parts: string[][] = [[]];
let size = 0;
for (const r of rows) {
  if (size + r.length > MAX && parts[parts.length - 1].length) { parts.push([]); size = 0; }
  parts[parts.length - 1].push(r); size += r.length + 1;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const n = parts.length;
parts.forEach((p, i) => {
  const label = `PART ${i + 1} OF ${n}`;
  const body = [
    `-- ${label} of the boundary seed (split by scripts/split-boundary-seed.ts).`,
    `-- Run the parts in any order, each once (re-running is a no-op). Same data,`,
    `-- licence and rules as ../liberia_boundaries_geoboundaries.sql.`,
    header, insertHead, p.join(",\n"), tail,
  ].join("\n");
  writeFileSync(`${OUT}/part_${String(i + 1).padStart(2, "0")}_of_${String(n).padStart(2, "0")}.sql`, body);
});
console.log(`${rows.length} rows -> ${n} parts`);
