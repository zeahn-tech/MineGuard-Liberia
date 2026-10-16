// ---------------------------------------------------------------------------
// Read reliability — a stalled request must never leave a screen waiting forever.
//
// The reported failure: "Still loading your account … the exact error is logged
// in the browser console" on a phone. Reproduced in a real browser: when the
// profile request STALLS (neither succeeds nor fails — mobile data, a tab
// resuming from the background) the app made ONE request in 17 s and waited on
// it for ever (the retry loop only re-ran after a thrown error), and when it
// FAILED the real reason was only in a console nobody can open on a phone.
//
// Driven through the real `api` with a client whose reads can be made to stall
// or fail. The timeout is shrunk so a stall is observable in milliseconds.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  __testSetReadTimeout,
  api,
  getLoadProblems,
  notifyResume,
} from "../src/lib/backend";
import { __testSetAuthUserId, __testSetSupabaseClient } from "../src/lib/supabase";
import { createEdgeClient, EDGE_IDS as f, edgeIdentity, getEdgeDb } from "./helpers/backend-edge";

type Mode = "ok" | "stall" | "fail";
type Table = "profiles" | "sites";

const state = {
  failMessage: "permission denied for table profiles",
  mode: { profiles: "ok", sites: "ok" } as Record<Table, Mode>,
  calls: { profiles: 0, sites: 0 } as Record<Table, number>,
  aborted: 0,
};

/** A query that never settles — unless its AbortSignal fires, like real fetch. */
function stalledBuilder() {
  let signal: AbortSignal | undefined;
  const b: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (_resolve: unknown, reject: (e: unknown) => void) => {
            signal?.addEventListener("abort", () => {
              state.aborted++;
              reject(new DOMException("This operation was aborted", "AbortError"));
            });
          };
        }
        if (prop === "abortSignal") {
          return (s: AbortSignal) => {
            signal = s;
            return b;
          };
        }
        return () => b;
      },
    },
  );
  return b;
}

function failingBuilder(message: string) {
  const b: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (_ok: unknown, reject: (e: unknown) => void) => reject(new Error(message));
        return () => b;
      },
    },
  );
  return b;
}

function makeClient(): SupabaseClient {
  const real = createEdgeClient();
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "from") {
        return (table: string) => {
          const t = table as Table;
          if (t in state.mode) {
            state.calls[t]++;
            if (state.mode[t] === "stall") return stalledBuilder();
            if (state.mode[t] === "fail") return failingBuilder(state.failMessage);
          }
          return target.from(table);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as SupabaseClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
// A list read is recorded under every table it reads ("sites,corrective_actions").
const problem = (table: string) =>
  getLoadProblems().find((p) => p.scope.split(",").includes(table));

beforeAll(async () => {
  await getEdgeDb();
  __testSetSupabaseClient(makeClient());
  __testSetAuthUserId(f.admin);
  edgeIdentity.set(f.admin);
});
afterAll(() => {
  __testSetReadTimeout(null);
  __testSetSupabaseClient(createEdgeClient());
  __testSetAuthUserId(null);
  edgeIdentity.set(null);
});

function reset(timeoutMs = 150) {
  state.mode.profiles = "ok";
  state.mode.sites = "ok";
  state.calls.profiles = 0;
  state.calls.sites = 0;
  state.aborted = 0;
  state.failMessage = "permission denied for table profiles";
  __testSetReadTimeout(timeoutMs);
}

describe("a STALLED profile read (the 'Still loading your account' failure)", () => {
  test("times out, CANCELS the request, records the reason, and never pretends there is no profile", async () => {
    reset();
    state.mode.profiles = "stall";
    const values: unknown[] = [];
    const stop = api.users.currentUser().subscribe((v) => values.push(v));
    await until(() => problem("profiles") !== undefined, 2000, "a recorded problem");
    expect(problem("profiles")?.message).toContain("did not answer");
    expect(state.aborted).toBeGreaterThanOrEqual(1); // the socket is freed, not abandoned
    // Emitting null here would push a signed-in user into "no portal role assigned".
    expect(values).toEqual([]);
    stop();
  });

  test("recovers as soon as the connection returns (resume), and clears the recorded problem", async () => {
    reset();
    state.mode.profiles = "stall";
    const values: unknown[] = [];
    const stop = api.users.currentUser().subscribe((v) => values.push(v));
    await until(() => problem("profiles") !== undefined);
    state.mode.profiles = "ok";
    notifyResume(); // tab visible / back online — no waiting out a backoff
    await until(() => values.length > 0, 2000, "the profile");
    expect(values[0]).not.toBeNull();
    expect(problem("profiles")).toBeUndefined();
    stop();
  });

  test("keeps retrying by itself (no resume needed): a second request is made after the backoff", async () => {
    reset();
    state.mode.profiles = "stall";
    const stop = api.users.currentUser().subscribe(() => {});
    await until(() => state.calls.profiles >= 2, 4000, "an automatic retry");
    stop();
  });

  test("a long-stalled attempt is REPLACED on resume, not waited out", async () => {
    reset(3000); // would not time out for 3 s…
    state.mode.profiles = "stall";
    const values: unknown[] = [];
    const stop = api.users.currentUser().subscribe((v) => values.push(v));
    await sleep(1200); // …but has been stalled longer than a third of that
    expect(state.calls.profiles).toBe(1);
    state.mode.profiles = "ok";
    const t0 = Date.now();
    notifyResume();
    await until(() => values.length > 0, 2000, "the profile");
    expect(Date.now() - t0).toBeLessThan(1500); // far sooner than the 3 s limit
    expect(state.aborted).toBeGreaterThanOrEqual(1); // the dead request was cancelled
    stop();
  });
});

describe("a FAILING read: the real reason is recorded for the screen", () => {
  test("the actual message (no URL, no credential) is kept, and clears when the read succeeds", async () => {
    reset();
    state.mode.profiles = "fail";
    const stop = api.users.currentUser().subscribe(() => {});
    await until(() => problem("profiles") !== undefined);
    expect(problem("profiles")?.message).toContain("permission denied for table profiles");
    expect(problem("profiles")?.message).not.toMatch(/https?:|apikey|eyJ/i);
    state.mode.profiles = "ok";
    notifyResume();
    await until(() => problem("profiles") === undefined, 2000, "the problem to clear");
    stop();
  });
});

describe("what the screen is told is readable, whatever the server sent", () => {
  async function shown(message: string) {
    reset();
    state.failMessage = message;
    state.mode.profiles = "fail";
    const stop = api.users.currentUser().subscribe(() => {});
    await until(() => problem("profiles") !== undefined);
    const text = problem("profiles")!.message;
    state.mode.profiles = "ok";
    notifyResume();
    await until(() => problem("profiles") === undefined);
    stop();
    return text;
  }

  test("a JSON error body becomes its message and code, not raw JSON", async () => {
    expect(await shown('{"message":"JWT expired","code":"PGRST301","hint":null}')).toBe("JWT expired (PGRST301)");
  });
  test("an HTML error page (gateway/CDN) is never shown as markup", async () => {
    const text = await shown("<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>");
    expect(text).toBe("The server returned an error page instead of data.");
    expect(text).not.toContain("<");
  });
  test("a network failure keeps its plain text, and anything long is cut", async () => {
    expect(await shown("Load failed")).toBe("Load failed");
    expect((await shown("x".repeat(900))).length).toBeLessThanOrEqual(200);
  });
});

describe("list reads get the same protection", () => {
  test("a stalled list read times out, is reported under its table, and recovers on resume", async () => {
    reset();
    state.mode.sites = "stall";
    const values: unknown[] = [];
    const stop = api.sites.list().subscribe((v) => values.push(v));
    await until(() => problem("sites") !== undefined, 2000, "a recorded problem");
    expect(problem("sites")?.message).toContain("did not answer");
    state.mode.sites = "ok";
    notifyResume();
    await until(() => values.some((v) => Array.isArray(v)), 2000, "the site list");
    expect(problem("sites")).toBeUndefined();
    stop();
  });
});

describe("resume is cheap and safe", () => {
  test("a healthy, fresh query is NOT re-read when the tab becomes visible again", async () => {
    reset(5000);
    const values: unknown[] = [];
    const stop = api.users.currentUser().subscribe((v) => values.push(v));
    await until(() => values.length > 0);
    const calls = state.calls.profiles;
    notifyResume();
    await sleep(500); // longer than the 300 ms debounce
    expect(state.calls.profiles).toBe(calls);
    stop();
  });

  test("after unsubscribing, resume does nothing (a closed screen must not keep reading)", async () => {
    reset(5000);
    const values: unknown[] = [];
    const stop = api.users.currentUser().subscribe((v) => values.push(v));
    await until(() => values.length > 0);
    stop();
    state.mode.profiles = "stall"; // would be noticed if anything still read
    const calls = state.calls.profiles;
    notifyResume();
    await sleep(500);
    expect(state.calls.profiles).toBe(calls);
  });
});
