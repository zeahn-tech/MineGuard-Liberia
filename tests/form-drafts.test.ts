// ---------------------------------------------------------------------------
// FORM DRAFTS — the durable store that makes "your work is saved" true.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from "bun:test";
import {
  DRAFT_TTL_MS,
  clearAllFormDrafts,
  clearFormDraft,
  loadFormDraft,
  sameFormValue,
  saveFormDraft,
} from "../src/lib/form-drafts";
import { __resetOfflineStore } from "../src/lib/offline-store";

beforeEach(() => {
  __resetOfflineStore();
});

describe("form draft store", () => {
  test("saves and loads a draft exactly as written", async () => {
    const data = { siteId: "s1", description: "Rockfall near the north pit", injured: "2" };
    await saveFormDraft("user-a", "incident", data, 1_000);
    const d = await loadFormDraft<typeof data>("user-a", "incident", 2_000);
    expect(d?.data).toEqual(data);
    expect(d?.savedAt).toBe(1_000);
  });

  test("returns null when nothing was saved", async () => {
    expect(await loadFormDraft("user-a", "incident")).toBeNull();
  });

  test("drafts are private to the signed-in person: another user on the same device sees none", async () => {
    await saveFormDraft("user-a", "incident", { description: "private to A" });
    expect(await loadFormDraft("user-b", "incident")).toBeNull();
    expect((await loadFormDraft<{ description: string }>("user-a", "incident"))?.data.description).toBe("private to A");
  });

  test("different forms keep separate drafts; clearing one leaves the other", async () => {
    await saveFormDraft("u", "incident", { a: 1 });
    await saveFormDraft("u", "observation", { b: 2 });
    await clearFormDraft("u", "incident");
    expect(await loadFormDraft("u", "incident")).toBeNull();
    expect((await loadFormDraft<{ b: number }>("u", "observation"))?.data.b).toBe(2);
  });

  test("two forms saving at the same moment do not overwrite each other", async () => {
    await Promise.all([
      saveFormDraft("u", "incident", { a: 1 }),
      saveFormDraft("u", "observation", { b: 2 }),
      saveFormDraft("u", "response", { c: 3 }),
    ]);
    expect((await loadFormDraft<{ a: number }>("u", "incident"))?.data.a).toBe(1);
    expect((await loadFormDraft<{ b: number }>("u", "observation"))?.data.b).toBe(2);
    expect((await loadFormDraft<{ c: number }>("u", "response"))?.data.c).toBe(3);
  });

  test("a newer save replaces the older one", async () => {
    await saveFormDraft("u", "incident", { description: "first" }, 1_000);
    await saveFormDraft("u", "incident", { description: "second" }, 2_000);
    expect((await loadFormDraft<{ description: string }>("u", "incident", 3_000))?.data.description).toBe("second");
  });

  test("drafts expire after 14 days and are not resurrected", async () => {
    await saveFormDraft("u", "incident", { description: "old" }, 1_000);
    expect(await loadFormDraft("u", "incident", 1_000 + DRAFT_TTL_MS - 1)).not.toBeNull();
    expect(await loadFormDraft("u", "incident", 1_000 + DRAFT_TTL_MS + 1)).toBeNull();
  });

  test("clearAll removes every draft of that user only", async () => {
    await saveFormDraft("u1", "incident", { a: 1 });
    await saveFormDraft("u1", "observation", { b: 2 });
    await saveFormDraft("u2", "incident", { z: 9 });
    await clearAllFormDrafts("u1");
    expect(await loadFormDraft("u1", "incident")).toBeNull();
    expect(await loadFormDraft("u1", "observation")).toBeNull();
    expect((await loadFormDraft<{ z: number }>("u2", "incident"))?.data.z).toBe(9);
  });

  test("clearing a draft that does not exist is a harmless no-op", async () => {
    await clearFormDraft("nobody", "incident");
    expect(await loadFormDraft("nobody", "incident")).toBeNull();
  });

  test("sameFormValue compares by value", () => {
    expect(sameFormValue({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(sameFormValue({ a: 1 }, { a: 2 })).toBe(false);
  });
});
