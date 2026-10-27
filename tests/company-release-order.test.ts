// Release order: GitHub Pages deploys the frontend on merge to main and never
// applies migrations, so the frontend must not break on a database that has not
// received 0024-0027 yet (same convention as the 0023 fallback).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "backend.ts"), "utf8");

describe("frontend tolerates an un-migrated database", () => {
  test("operator layout membership lookup treats a missing mg_my_membership as 'no membership'", () => {
    const i = src.indexOf("myMembership:");
    const body = src.slice(i, i + 1600);
    expect(body).toContain('error.code === "PGRST202"');
    expect(body).toContain("could not find the function");
    expect(body).toContain("return null");
  });
  test("no privileged secret or service key is referenced by the client", () => {
    expect(src).not.toMatch(/service_role|SERVICE_ROLE/i);
  });
});
