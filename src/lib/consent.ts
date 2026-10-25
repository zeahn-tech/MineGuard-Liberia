// ---------------------------------------------------------------------------
// COOKIE / STORAGE CONSENT
//
// MineGuard sets NO cookies and runs NO analytics or advertising. Everything it
// keeps on a device is either strictly necessary for the service (sign-in
// session, offline queue, app cache, remembering this choice) or a small
// preference. The ONE optional item is the third-party map background
// (OpenStreetMap tiles): loading it reveals the visitor's network address and
// the area being viewed to that provider, so it is OPT-IN — off until the
// visitor accepts, and it can be withdrawn at any time.
//
// Bump CONSENT_VERSION if a new optional category is ever added: everyone is
// then asked again.
// ---------------------------------------------------------------------------
import { useSyncExternalStore } from "react";

export const CONSENT_STORAGE_KEY = "mg.consent.v1";
export const CONSENT_VERSION = 1;
const CHANGE_EVENT = "mg:consent-change";
const REOPEN_EVENT = "mg:consent-reopen";
const TILE_CACHE = "mgtiles-v1"; // keep in sync with src/lib/map-tiles.ts

export type ConsentChoice = { mapTiles: boolean };
type Stored = { v: number; mapTiles: boolean; at: string };

const NONE: ConsentChoice & { decided: false } = { mapTiles: false, decided: false };
export type ConsentState = ConsentChoice & { decided: boolean };

function read(): ConsentState {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CONSENT_STORAGE_KEY) : null;
    if (!raw) return NONE;
    const p = JSON.parse(raw) as Partial<Stored>;
    if (p.v !== CONSENT_VERSION || typeof p.mapTiles !== "boolean") return NONE;
    return { mapTiles: p.mapTiles, decided: true };
  } catch {
    return NONE;
  }
}

let snapshot: ConsentState = read();

function emit() {
  snapshot = read();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Current choice. Before any decision every optional category is OFF. */
export function getConsent(): ConsentState {
  return snapshot;
}

export function mapTilesAllowed(): boolean {
  return snapshot.mapTiles;
}

/** Record the visitor's choice (and honour a withdrawal by deleting what the
 *  optional category had stored). */
export function setConsent(choice: ConsentChoice): void {
  const value: Stored = { v: CONSENT_VERSION, mapTiles: choice.mapTiles, at: new Date().toISOString() };
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage blocked: the choice still applies for this page view */
    snapshot = { mapTiles: choice.mapTiles, decided: true };
    if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
    return;
  }
  if (!choice.mapTiles && typeof caches !== "undefined") {
    void caches.delete(TILE_CACHE).catch(() => undefined);
  }
  emit();
}

/** Ask the banner to open again (footer "Cookie settings" link). */
export function reopenConsent(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REOPEN_EVENT));
}

export function onConsentReopen(fn: () => void): () => void {
  window.addEventListener(REOPEN_EVENT, fn);
  return () => window.removeEventListener(REOPEN_EVENT, fn);
}

function subscribe(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === CONSENT_STORAGE_KEY || e.key === null) {
      snapshot = read();
      cb();
    }
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useConsent(): ConsentState {
  return useSyncExternalStore(subscribe, getConsent, () => NONE);
}

/** Test hook: re-read storage. */
export function __resetConsentForTests(): void {
  snapshot = read();
}
