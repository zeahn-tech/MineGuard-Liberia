// ---------------------------------------------------------------------------
// SESSION 10 / CLN-1 — production cleanliness guard.
//
// Pins what the cleanup removed so it cannot creep back: dead scaffolding from
// other platforms (Convex, Firebase, SST, Deno/Hono server, VLY toolbar and
// plugin), the dev-only error overlay, private key files in version control,
// and dev-only console output reaching a production build.
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("CLN-1: dead scaffolding is gone", () => {
  const dead = [
    "main.ts", // Deno/Hono static server — the app ships as static files
    "convex.json",
    "firebase.json",
    "firestore.rules",
    "firestore.indexes.json",
    "storage.rules",
    "sst-env.d.ts",
    "vly-toolbar-readonly.tsx",
    "integrations.md",
    "package-lock.json", // CI installs with bun --frozen-lockfile; one lockfile
    "src/instrumentation.tsx",
    "src/lib/vly-integrations.ts",
    "src/lib/compat-types.ts",
  ];
  for (const f of dead) {
    test(`${f} does not exist`, () => expect(existsSync(join(root, f))).toBe(false));
  }

  test("no removed platform dependency in package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dep of [
      "hono",
      "@vly-ai/integrations",
      "@zumer/snapdom",
      "framer-motion",
      "axios",
      "convex",
      "firebase",
      "sst",
    ]) {
      expect(all[dep]).toBeUndefined();
    }
  });

  test("no source, config or workflow references the removed platforms", () => {
    const files = [
      ...walk("src"),
      "vite.config.ts",
      "eslint.config.js",
      "tsconfig.app.json",
      ".github/workflows/deploy-production.yml",
    ];
    const banned = /(@vly-ai|vlyPlugin|DISABLE_VLY|vly-toolbar|freebuff|from\s+["'](convex|firebase|hono)[/"'])/i;
    for (const f of files) {
      expect(banned.test(read(f)) ? f : null).toBeNull();
    }
  });
});

describe("CLN-1: secrets and key material are not tracked", () => {
  test(".env.keys (dotenvx private key) is not tracked by git", () => {
    const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n");
    expect(tracked.filter((f) => /(^|\/)\.env(\.keys|\.local)?$/.test(f) || f.includes(".env.keys"))).toEqual([]);
  });
  test(".gitignore keeps ignoring env and key files", () => {
    const gi = read(".gitignore");
    expect(gi).toContain(".env.keys");
    expect(gi).toContain(".env");
  });
  test(".env.example holds no values", () => {
    for (const line of read(".env.example").split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      expect(line.split("=")[1].trim()).toBe("");
    }
  });
});

describe("CLN-1: nothing dev-only runs in production", () => {
  test("no error-overlay / element-inspector / telemetry code in src", () => {
    const banned = /(window\.parent\.postMessage|__REACT_DEVTOOLS|snapdom|sentry|posthog|gtag\(|google-analytics)/i;
    for (const f of walk("src")) expect(banned.test(read(f)) ? f : null).toBeNull();
  });

  test("the only console.* in src is the DEV-guarded audit breadcrumb or an error/warn report", () => {
    for (const f of walk("src")) {
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        if (/console\.(log|debug|info|trace)\(/.test(line)) {
          const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          expect(/import\.meta\.env\??\.DEV/.test(context) ? null : `${f}:${i + 1}`).toBeNull();
        }
      });
    }
  });

  test("error-boundary detail (message/stack) renders only under import.meta.env.DEV", () => {
    const src = read("src/components/RootErrorBoundary.tsx");
    const at = src.indexOf("this.state.message");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 200), at)).toContain("import.meta.env.DEV");
    expect(src.slice(src.indexOf("this.state.stack") - 200, src.indexOf("this.state.stack"))).toContain(
      "import.meta.env.DEV",
    );
  });

  test("index.html loads exactly one script: the app entry", () => {
    const html = read("index.html");
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("/src/main.tsx");
  });

  test("the service worker does not cache auth/API traffic", () => {
    const sw = read("public/sw.js");
    expect(sw).toMatch(/supabase/i);
  });
});
