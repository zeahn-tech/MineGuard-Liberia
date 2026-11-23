// In-app sharing: the links we hand to other apps must carry the PUBLIC app
// address (never a deep link), be correctly encoded, and degrade gracefully when
// the device has no native share sheet or clipboard access.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARE_MESSAGE,
  buildShareTargets,
  canUseNativeShare,
  getShareUrl,
  nativeShare,
} from "../src/lib/share";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("getShareUrl", () => {
  test("is the origin plus the app base path, always ending in a slash", () => {
    expect(getShareUrl({ origin: "https://x.example", baseUrl: "/MineGuard-Liberia/", override: "" })).toBe(
      "https://x.example/MineGuard-Liberia/",
    );
    expect(getShareUrl({ origin: "https://x.example", baseUrl: "/", override: "" })).toBe("https://x.example/");
    expect(getShareUrl({ origin: "https://x.example", baseUrl: "app", override: "" })).toBe("https://x.example/app/");
  });

  test("a valid configured public address wins; an invalid one is ignored", () => {
    expect(getShareUrl({ origin: "https://x.example", baseUrl: "/", override: "https://mineguard.example/" })).toBe(
      "https://mineguard.example/",
    );
    expect(getShareUrl({ origin: "https://x.example", baseUrl: "/", override: "javascript:alert(1)" })).toBe(
      "https://x.example/",
    );
    expect(getShareUrl({ origin: "https://x.example", baseUrl: "/", override: "not a url" })).toBe("https://x.example/");
  });
});

describe("buildShareTargets", () => {
  const url = "https://x.example/MineGuard-Liberia/?a=1&b=2";
  const targets = buildShareTargets(url);
  const by = (id: string) => targets.find((t) => t.id === id)!;

  test("offers the main social and messaging apps plus SMS and email", () => {
    expect(targets.map((t) => t.id)).toEqual(["whatsapp", "facebook", "x", "telegram", "linkedin", "sms", "email"]);
  });

  test("every link carries the encoded address and nothing leaks unencoded", () => {
    for (const t of targets) {
      expect(t.href).toContain(encodeURIComponent(url));
      expect(t.href).not.toContain("&b=2");
    }
  });

  test("web targets open in a new tab; sms/mailto hand off to the installed app", () => {
    for (const id of ["whatsapp", "facebook", "x", "telegram", "linkedin"]) {
      expect(by(id).href.startsWith("https://")).toBe(true);
      expect(by(id).opensInNewTab).toBe(true);
    }
    expect(by("sms").href.startsWith("sms:")).toBe(true);
    expect(by("email").href.startsWith("mailto:")).toBe(true);
    expect(by("sms").opensInNewTab).toBe(false);
    expect(by("email").opensInNewTab).toBe(false);
  });

  test("the prefilled text is the invitation and never claims to be an official system", () => {
    expect(by("whatsapp").href).toContain(encodeURIComponent(SHARE_MESSAGE));
    expect(SHARE_MESSAGE.toLowerCase()).not.toContain("official");
  });
});

describe("native share", () => {
  test("is detected from navigator.share", () => {
    expect(canUseNativeShare({ share: async () => {} })).toBe(true);
    expect(canUseNativeShare({} as Navigator)).toBe(false);
    expect(canUseNativeShare(undefined)).toBe(false);
  });

  test("reports shared / cancelled / failed / unsupported without throwing", async () => {
    const url = "https://x.example/";
    expect(await nativeShare(url, { share: async () => {} })).toBe("shared");
    expect(
      await nativeShare(url, {
        share: async () => {
          throw new DOMException("closed", "AbortError");
        },
      }),
    ).toBe("cancelled");
    expect(
      await nativeShare(url, {
        share: async () => {
          throw new Error("boom");
        },
      }),
    ).toBe("failed");
    expect(await nativeShare(url, {} as Navigator)).toBe("unsupported");
  });
});

describe("share entry points", () => {
  test.each([
    "src/pages/PortalLayout.tsx",
    "src/pages/RegistryLayout.tsx",
    "src/pages/operate/OperatorLayout.tsx",
  ])("%s offers Share app in the sidebar and in the phone drawer", (file) => {
    expect((read(file).match(/<ShareAppButton/g) ?? []).length).toBe(2);
  });

  test("the landing page and public pages offer it too", () => {
    expect(read("src/pages/Landing.tsx")).toContain("<ShareAppButton");
    expect(read("src/components/PublicHeader.tsx")).toContain("<ShareAppButton");
  });
});
