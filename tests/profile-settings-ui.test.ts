import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_MAX_SOURCE_BYTES, initialsOf, squareCrop, validateAvatarFile } from "../src/lib/avatar-image";
import { cachedAvatar, forgetAvatar, rememberAvatar } from "../src/lib/avatar-cache";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("profile photo preparation", () => {
  test("only JPEG, PNG and WebP of a sensible size are accepted", () => {
    expect(validateAvatarFile({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(validateAvatarFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(validateAvatarFile({ type: "image/webp", size: 1000 })).toBeNull();
    for (const type of ["image/svg+xml", "image/gif", "application/pdf", "text/html", ""]) {
      expect(validateAvatarFile({ type, size: 1000 }), type).toMatch(/JPEG, PNG or WebP/);
    }
    expect(validateAvatarFile({ type: "image/jpeg", size: 0 })).toMatch(/empty/);
    expect(validateAvatarFile({ type: "image/jpeg", size: AVATAR_MAX_SOURCE_BYTES + 1 })).toMatch(/10 MB/);
  });
  test("the crop is the centred square", () => {
    expect(squareCrop(1000, 600)).toEqual({ sx: 200, sy: 0, side: 600 });
    expect(squareCrop(600, 1000)).toEqual({ sx: 0, sy: 200, side: 600 });
    expect(squareCrop(500, 500)).toEqual({ sx: 0, sy: 0, side: 500 });
  });
  test("initials never fail", () => {
    expect(initialsOf("Ada Lovelace", null)).toBe("AL");
    expect(initialsOf("Cher", null)).toBe("CH");
    expect(initialsOf(null, "grace.hopper@x.test")).toBe("GH");
    expect(initialsOf("", "")).toBe("?");
    expect(initialsOf("  ", null)).toBe("?");
  });
  test("the signed-link cache expires and can be cleared", () => {
    expect(cachedAvatar("p/avatar.jpg")).toBeUndefined();
    rememberAvatar("p/avatar.jpg", "https://x/y");
    expect(cachedAvatar("p/avatar.jpg")).toBe("https://x/y");
    forgetAvatar("p/avatar.jpg");
    expect(cachedAvatar("p/avatar.jpg")).toBeUndefined();
  });
  test("the canvas redraw (which drops location metadata) is what produces the upload", () => {
    const s = read("src/lib/avatar-image.ts");
    expect(s).toContain("drawImage");
    expect(s).toContain('"image/jpeg"');
    expect(read("src/lib/backend.ts")).toMatch(/uploadAvatar: async \(blob: Blob\)/);
  });
});

describe("profile page contracts", () => {
  const page = read("src/pages/ProfileSettings.tsx");
  test("deleting needs the password AND the typed word, and blockers are shown before anything", () => {
    expect(page).toContain('typed !== "DELETE"');
    expect(page).toContain("!password");
    expect(page).toContain("deletionBlockers");
    expect(page).toMatch(/not deleted<\/strong>/);
  });
  test("role, company and email are shown but not editable here", () => {
    expect(page).toContain("changed by an administrator");
    expect(page).not.toMatch(/<Input[^>]*value=\{user\.email/);
  });
  test("every shell has a route and a link to it", () => {
    const m = read("src/main.tsx");
    // One route per shell; the operator's wraps the page in the admin's padding
    // (see app-shell-parity), so allow an optional <div …> around it.
    expect((m.match(/path="profile"\s+element=\{\s*(?:<div[^>]*>\s*)?<ProfileSettings \/>/g) ?? []).length).toBe(3);
    expect(read("src/pages/PortalLayout.tsx")).toContain('"/portal/profile"');
    expect(read("src/pages/operate/OperatorLayout.tsx")).toContain('"/operate/profile"');
    expect(read("src/pages/RegistryLayout.tsx")).toContain('"/registry/profile"');
  });
  test("the photo is private: no public URL is ever built", () => {
    const b = read("src/lib/backend.ts");
    expect(b).toContain("createSignedUrl");
    expect(b).not.toContain("getPublicUrl");
  });
});
