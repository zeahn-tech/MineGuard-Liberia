// Share-the-app links: the public URL is built from the deployment base path and
// every channel link carries the URL, encoded, with no tracking parameters.
import { describe, expect, test } from "bun:test";
import { appShareUrl, SHARE_CHANNELS } from "../src/lib/share";

describe("appShareUrl", () => {
  test("joins origin and base path", () => {
    expect(appShareUrl("https://zeahn-tech.github.io", "/MineGuard-Liberia/")).toBe("https://zeahn-tech.github.io/MineGuard-Liberia/");
    expect(appShareUrl("https://example.org", "/")).toBe("https://example.org/");
  });
});

describe("share channels", () => {
  const url = "https://zeahn-tech.github.io/MineGuard-Liberia/";
  test("each channel link contains the encoded app URL", () => {
    for (const c of SHARE_CHANNELS) {
      const href = c.href(url);
      expect(href.includes(encodeURIComponent(url))).toBe(true);
    }
  });
  test("web channels are https; sms and email hand off to the device", () => {
    for (const c of SHARE_CHANNELS) {
      if (c.external) expect(c.href(url)).toMatch(/^https:\/\//);
    }
    expect(SHARE_CHANNELS.find((c) => c.id === "email")!.href(url)).toMatch(/^mailto:/);
    expect(SHARE_CHANNELS.find((c) => c.id === "sms")!.href(url)).toMatch(/^sms:/);
  });
  test("includes the main social apps", () => {
    const ids = SHARE_CHANNELS.map((c) => c.id);
    for (const id of ["whatsapp", "facebook", "x", "telegram", "linkedin"]) expect(ids).toContain(id);
  });
});
