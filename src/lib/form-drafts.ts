// ---------------------------------------------------------------------------
// FORM DRAFTS — durable, per-user storage for report forms that are still being
// filled in, so a timeout, a dropped connection, a crash or a closed tab never
// costs anyone what they typed.
//
// Built on the offline store: every write is READ BACK and verified, and a
// failed write throws (NotSavedError) instead of being swallowed — callers must
// never tell a person their work is saved when it is not.
//
// ONE storage key per signed-in user holds every form's draft, so another
// person who signs in on the same device never sees these. Drafts older than
// DRAFT_TTL_MS are dropped. Writes are serialised so two forms saving at once
// cannot overwrite each other.
// ---------------------------------------------------------------------------

import { storeGet, storeRemove, storeSet } from "./offline-store";

export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const keyOf = (uid: string) => `mg.formdrafts.v1.${uid}`;

interface StoredDraft {
  savedAt: number;
  data: unknown;
}
type Bag = Record<string, StoredDraft>;

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

function isBag(v: unknown): v is Bag {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readBag(uid: string, now: number): Promise<Bag> {
  const raw = await storeGet<unknown>(keyOf(uid));
  if (!isBag(raw)) return {};
  const out: Bag = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && typeof v.savedAt === "number" && now - v.savedAt < DRAFT_TTL_MS) out[k] = v;
  }
  return out;
}

/** The saved draft for one form, or null. */
export function loadFormDraft<T>(
  uid: string,
  form: string,
  now: number = Date.now(),
): Promise<{ savedAt: number; data: T } | null> {
  return serial(async () => {
    const d = (await readBag(uid, now))[form];
    return d ? { savedAt: d.savedAt, data: d.data as T } : null;
  });
}

/** Save (replace) one form's draft. Throws if the device could not keep it. */
export function saveFormDraft(uid: string, form: string, data: unknown, now: number = Date.now()): Promise<void> {
  return serial(async () => {
    const bag = await readBag(uid, now);
    bag[form] = { savedAt: now, data };
    await storeSet(keyOf(uid), bag);
  });
}

/** Remove one form's draft (after a successful submit or an explicit discard). */
export function clearFormDraft(uid: string, form: string): Promise<void> {
  return serial(async () => {
    const bag = await readBag(uid, Date.now());
    if (!(form in bag)) return;
    delete bag[form];
    if (Object.keys(bag).length === 0) await storeRemove(keyOf(uid));
    else await storeSet(keyOf(uid), bag);
  });
}

/** Remove every draft of a user (explicit sign-out on a device with nothing queued). */
export function clearAllFormDrafts(uid: string): Promise<void> {
  return serial(() => storeRemove(keyOf(uid)));
}

/** Structural equality for form values (plain JSON data). */
export function sameFormValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
