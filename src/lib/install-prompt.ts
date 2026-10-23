// ---------------------------------------------------------------------------
// "INSTALL THE APP" PROMPT — capture + schedule
//
// Goal: draw attention to installing the PWA without nagging forever.
//   • First open: the banner appears a few seconds after the app loads.
//   • If it is dismissed it comes back after a short gap — three times in
//     total (a "burst") — so the person really sees it.
//   • If they still have not installed after the burst, it goes quiet for a
//     much longer time (7 days, then 14, then 30 — never shorter again) before
//     the next burst.
//   • Never shown when the app is already installed / running standalone.
//
// The schedule is a pure function of persisted state (unit-tested); the
// browser plumbing (beforeinstallprompt, iOS detection) sits around it.
// ---------------------------------------------------------------------------

export const INSTALL_STORAGE_KEY = "mg.install.v1";

/** Tunables — one place so the cadence is easy to adjust. */
export const INSTALL_CONFIG = {
  /** Delay before the very first banner, and before each new burst. */
  firstDelayMs: 4_000,
  /** Gap between banners inside a burst (after a dismissal). */
  burstGapMs: 25_000,
  /** Banners per burst. */
  burstSize: 3,
  /** Quiet period after a burst: 7 days, then 14, then 30 (cap). */
  cooldownsMs: [7, 14, 30].map((d) => d * 24 * 60 * 60 * 1000),
} as const;

/** setTimeout cannot exceed a signed 32-bit delay (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type InstallState = {
  /** Banners shown in the current burst (0..burstSize). */
  shownInBurst: number;
  /** Bursts whose last banner has been shown (drives the growing cooldown). */
  bursts: number;
  /** When a banner was last shown / dismissed (ms epoch). */
  lastShownAt: number | null;
  lastDismissedAt: number | null;
  /** Installed (appinstalled / accepted the native prompt). */
  installed: boolean;
};

export const FRESH_INSTALL_STATE: InstallState = {
  shownInBurst: 0,
  bursts: 0,
  lastShownAt: null,
  lastDismissedAt: null,
  installed: false,
};

const lastTouch = (s: InstallState) => Math.max(s.lastShownAt ?? 0, s.lastDismissedAt ?? 0);

/** How long to wait (ms from `now`) before the next banner, or null for never.
 *  Pure. */
export function nextInstallPromptDelay(
  s: InstallState,
  now: number,
  cfg: typeof INSTALL_CONFIG = INSTALL_CONFIG,
): number | null {
  if (s.installed) return null;

  // Burst finished → long cooldown, then a fresh burst.
  if (s.shownInBurst >= cfg.burstSize) {
    const cooldown = cfg.cooldownsMs[Math.min(Math.max(s.bursts - 1, 0), cfg.cooldownsMs.length - 1)];
    const remaining = cooldown - (now - lastTouch(s));
    return remaining > 0 ? remaining : cfg.firstDelayMs;
  }

  // Nothing shown yet in this burst.
  if (s.shownInBurst === 0) return cfg.firstDelayMs;

  // Mid-burst: short gap since the last banner (never instant, never negative).
  const remaining = cfg.burstGapMs - (now - lastTouch(s));
  return Math.max(remaining, cfg.firstDelayMs / 2);
}

/** State after a banner is shown. A burst that already finished and whose
 *  cooldown elapsed starts a new one. */
export function afterShown(
  s: InstallState,
  now: number,
  cfg: typeof INSTALL_CONFIG = INSTALL_CONFIG,
): InstallState {
  const base = s.shownInBurst >= cfg.burstSize ? { ...s, shownInBurst: 0 } : s;
  const shownInBurst = base.shownInBurst + 1;
  return {
    ...base,
    shownInBurst,
    // The burst is complete once its last banner is on screen — even if the tab
    // is closed before it is dismissed, the long cooldown still applies.
    bursts: shownInBurst === cfg.burstSize ? base.bursts + 1 : base.bursts,
    lastShownAt: now,
  };
}

/** State after the person dismisses a banner ("Not now" / closed). */
export function afterDismissed(s: InstallState, now: number): InstallState {
  return { ...s, lastDismissedAt: now };
}

// ------------------------------------------------------------ persistence

function loadState(): InstallState {
  try {
    const raw = localStorage.getItem(INSTALL_STORAGE_KEY);
    if (!raw) return { ...FRESH_INSTALL_STATE };
    const p = JSON.parse(raw) as Partial<InstallState>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      shownInBurst: Math.max(0, Math.min(INSTALL_CONFIG.burstSize, num(p.shownInBurst) ?? 0)),
      bursts: Math.max(0, num(p.bursts) ?? 0),
      lastShownAt: num(p.lastShownAt),
      lastDismissedAt: num(p.lastDismissedAt),
      installed: p.installed === true,
    };
  } catch {
    return { ...FRESH_INSTALL_STATE };
  }
}

function saveState(s: InstallState) {
  try {
    localStorage.setItem(INSTALL_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked — the in-memory state still paces this session */
  }
}

// ------------------------------------------------------- environment checks

/** Already running as an installed app. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  } catch {
    /* ignore */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone / iPad Safari: no install event — the person must use Share →
 *  "Add to Home Screen", so the banner shows those steps instead. */
export function isIosSafari(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  const iOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
  const webkit = /safari/i.test(ua) && !/crios|fxios|edgios|opios|duckduckgo|gsa/i.test(ua);
  return iOS && webkit;
}

// ------------------------------------------------------------------ store

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallView = {
  /** Banner currently on screen. */
  visible: boolean;
  /** "native" = we can open the browser's install dialog; "ios" = show steps. */
  mode: "native" | "ios" | null;
};

let state: InstallState = { ...FRESH_INSTALL_STATE };
let deferred: BeforeInstallPromptEvent | null = null;
let view: InstallView = { visible: false, mode: null };
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const listeners = new Set<() => void>();

function setView(next: InstallView) {
  if (next.visible === view.visible && next.mode === view.mode) return;
  view = next;
  for (const l of listeners) l();
}

export const getInstallView = () => view;
export function subscribeInstall(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function currentMode(): InstallView["mode"] {
  if (state.installed || isStandalone()) return null;
  if (deferred) return "native";
  if (isIosSafari()) return "ios";
  return null; // browser cannot install → nothing useful to offer
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** (Re)arm the timer for the next banner. Safe to call any time. */
function schedule() {
  clearTimer();
  if (view.visible) return;
  const mode = currentMode();
  if (!mode) return;
  const delay = nextInstallPromptDelay(state, Date.now());
  if (delay === null) return;
  // A 30-day cooldown exceeds setTimeout's ~24.8-day ceiling: wait in chunks
  // and re-evaluate, never fire early.
  const chunked = delay > MAX_TIMER_MS;
  timer = setTimeout(() => {
    timer = null;
    if (chunked) {
      schedule();
      return;
    }
    // Only interrupt someone who is actually looking at the app.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const m = currentMode();
    if (!m) return;
    state = afterShown(state, Date.now());
    saveState(state);
    setView({ visible: true, mode: m });
  }, Math.min(delay, MAX_TIMER_MS));
}

/** Start listening. Call once, as early as possible (before React mounts) —
 *  `beforeinstallprompt` can fire before the first render. */
export function startInstallPrompt(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  state = loadState();
  if (isStandalone() && !state.installed) {
    state = { ...state, installed: true };
    saveState(state);
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own banner instead of the mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    schedule();
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    state = { ...state, installed: true };
    saveState(state);
    clearTimer();
    setView({ visible: false, mode: null });
  });

  // Re-arm when the tab becomes visible again (a hidden tab never pops up).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule();
  });

  schedule(); // covers iOS (no event) and a page that already has an event
}

/** "Not now" / close. */
export function dismissInstallBanner(): void {
  state = afterDismissed(state, Date.now());
  saveState(state);
  setView({ visible: false, mode: null });
  schedule();
}

/** "Install": open the browser's install dialog. */
export async function acceptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = deferred;
  if (!ev) return "unavailable";
  deferred = null; // an event can be used once
  setView({ visible: false, mode: null });
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "accepted") {
      state = { ...state, installed: true };
      saveState(state);
      clearTimer();
      return "accepted";
    }
  } catch {
    /* treat as dismissed */
  }
  state = afterDismissed(state, Date.now());
  saveState(state);
  schedule(); // a fresh beforeinstallprompt may re-arm it later
  return "dismissed";
}

/** TEST HOOK ONLY. */
export function __resetInstallForTests() {
  clearTimer();
  state = { ...FRESH_INSTALL_STATE };
  deferred = null;
  view = { visible: false, mode: null };
  started = false;
  listeners.clear();
}
