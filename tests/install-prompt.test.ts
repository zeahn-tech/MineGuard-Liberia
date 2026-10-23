// Install banner pacing: pops up on first open, three times in quick
// succession, then goes quiet for a much longer (growing) time.
import { describe, expect, test } from "bun:test";
import {
  FRESH_INSTALL_STATE,
  INSTALL_CONFIG as C,
  afterDismissed,
  afterShown,
  isIosSafari,
  nextInstallPromptDelay,
  type InstallState,
} from "../src/lib/install-prompt";

const DAY = 24 * 60 * 60 * 1000;

/** Drive the schedule like the app does: wait the delay, show, dismiss `dismissAfter` ms later. */
function runBurst(start: InstallState, t0: number, dismissAfter = 2_000) {
  let s = start;
  let t = t0;
  const shownAt: number[] = [];
  for (let i = 0; i < C.burstSize; i++) {
    const d = nextInstallPromptDelay(s, t);
    expect(d).not.toBeNull();
    t += d!;
    s = afterShown(s, t);
    shownAt.push(t);
    t += dismissAfter;
    s = afterDismissed(s, t);
  }
  return { s, t, shownAt };
}

describe("install banner schedule", () => {
  test("first open: appears after a few seconds", () => {
    expect(nextInstallPromptDelay(FRESH_INSTALL_STATE, 1_000)).toBe(C.firstDelayMs);
    expect(C.firstDelayMs).toBeGreaterThanOrEqual(2_000);
    expect(C.firstDelayMs).toBeLessThanOrEqual(10_000);
  });

  test("shows three times in quick succession (seconds apart)", () => {
    const { shownAt } = runBurst(FRESH_INSTALL_STATE, 0);
    expect(shownAt).toHaveLength(3);
    // each reminder follows the previous within well under two minutes
    expect(shownAt[1] - shownAt[0]).toBeLessThan(2 * 60_000);
    expect(shownAt[2] - shownAt[1]).toBeLessThan(2 * 60_000);
    expect(shownAt[1]).toBeGreaterThan(shownAt[0]);
  });

  test("after the third banner it goes quiet for a MUCH longer time (7 days)", () => {
    const { s, t } = runBurst(FRESH_INSTALL_STATE, 0);
    const wait = nextInstallPromptDelay(s, t);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(6.9 * DAY);
    expect(wait!).toBeGreaterThan(1000 * C.burstGapMs); // vastly longer than the in-burst gap
  });

  test("the quiet period survives reopening the app the next day", () => {
    const { s, t } = runBurst(FRESH_INSTALL_STATE, 0);
    const wait = nextInstallPromptDelay(s, t + DAY);
    expect(wait!).toBeGreaterThan(5.9 * DAY);
  });

  test("after the cooldown a new burst starts, with a longer cooldown next time", () => {
    const first = runBurst(FRESH_INSTALL_STATE, 0);
    const reopened = first.t + 8 * DAY;
    expect(nextInstallPromptDelay(first.s, reopened)).toBe(C.firstDelayMs);

    const second = runBurst(first.s, reopened);
    expect(second.shownAt).toHaveLength(3);
    const wait2 = nextInstallPromptDelay(second.s, second.t);
    expect(wait2!).toBeGreaterThan(13.9 * DAY); // 14 days

    const third = runBurst(second.s, second.t + 15 * DAY);
    const wait3 = nextInstallPromptDelay(third.s, third.t);
    expect(wait3!).toBeGreaterThan(29.9 * DAY); // 30 days
    const fourth = runBurst(third.s, third.t + 31 * DAY);
    const wait4 = nextInstallPromptDelay(fourth.s, fourth.t);
    expect(wait4!).toBeGreaterThan(29.9 * DAY); // never shorter than 30 days (the app chunks the timer)
  });

  test("closing the tab on the 3rd banner still counts as a finished burst", () => {
    let s: InstallState = FRESH_INSTALL_STATE;
    let t = 0;
    for (let i = 0; i < 3; i++) {
      t += nextInstallPromptDelay(s, t)!;
      s = afterShown(s, t);
      if (i < 2) s = afterDismissed(s, t + 1_000);
      t += 1_000;
    }
    // (never dismissed the 3rd)
    expect(nextInstallPromptDelay(s, t + 60_000)!).toBeGreaterThan(6.9 * DAY);
    expect(s.bursts).toBe(1);
  });

  test("reopening mid-burst continues it after a few seconds", () => {
    let s = afterShown(FRESH_INSTALL_STATE, 0);
    s = afterDismissed(s, 1_000);
    const d = nextInstallPromptDelay(s, 10 * 60_000); // reopened ten minutes later
    expect(d!).toBeLessThanOrEqual(C.burstGapMs);
    expect(d!).toBeGreaterThan(0);
  });

  test("never shows once installed", () => {
    expect(nextInstallPromptDelay({ ...FRESH_INSTALL_STATE, installed: true }, 0)).toBeNull();
  });
});

describe("iOS detection", () => {
  test("iPhone Safari yes; iPhone Chrome / Android no", () => {
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isIosSafari(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
    expect(
      isIosSafari("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36"),
    ).toBe(false);
  });
});

describe("wiring", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  test("listener starts before render and the banner is mounted app-wide", async () => {
    const main = await read("../src/main.tsx");
    expect(main).toContain("startInstallPrompt()");
    expect(main).toContain("<InstallBanner />");
    expect(main.indexOf("startInstallPrompt()")).toBeLessThan(main.indexOf("createRoot("));
  });
  test("custom banner suppresses the browser's own mini-infobar and is never shown when installed", async () => {
    const src = await read("../src/lib/install-prompt.ts");
    expect(src).toContain("e.preventDefault()");
    expect(src).toContain('"appinstalled"');
    expect(src).toContain("isStandalone()");
  });
});
