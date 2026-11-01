import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { clearFormDraft, loadFormDraft, saveFormDraft, sameFormValue } from "@/lib/form-drafts";
import { authUserId } from "@/lib/supabase";

/** Quiet period after the last keystroke before the draft is written. */
export const DRAFT_DEBOUNCE_MS = 500;

export interface FormDraft<T> {
  form: T;
  setForm: Dispatch<SetStateAction<T>>;
  /** When a saved draft was put back into the form (null if none was). */
  restoredAt: number | null;
  /** The form differs from its blank state, i.e. there is something to lose. */
  hasDraft: boolean;
  /** The device could not keep the draft — do NOT tell the person it is saved. */
  saveFailed: boolean;
  /** Call after a successful submit: forget the draft and the "restored" note. */
  clearDraft: () => void;
  /** The person chose to throw their draft away: reset to blank and forget it. */
  discardDraft: () => void;
}

/**
 * useState for a report form, with the draft kept safe on the device.
 *
 *  - Every change is saved (debounced) under the signed-in person's own key.
 *  - On the next visit — after a timeout sign-out, a crash, a closed tab — the
 *    draft is put back and `restoredAt` says when it was saved.
 *  - Saves are flushed when the page is hidden or the form unmounts.
 *  - Signed out (no user id): behaves exactly like useState, nothing is stored.
 *
 * `initial` is read once; it is the blank form.
 */
export function useFormDraft<T extends object>(formKey: string, initial: T): FormDraft<T> {
  const uid = authUserId();
  // The blank form, captured once (a state snapshot, never set: safe to read in render).
  const [blank] = useState<T>(initial);
  const [form, setForm] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  // Latest values for the flush handlers (kept out of render).
  const latest = useRef({ form, uid, ready });
  useEffect(() => {
    latest.current = { form, uid, ready };
  });

  // Set by clearDraft(): the form was just submitted or discarded, so the
  // flush-on-unmount must not write the old text back as a "draft". Lifted as
  // soon as the form changes again.
  const cleared = useRef(false);
  useEffect(() => {
    cleared.current = false;
  }, [form]);

  const persist = useCallback(
    async (value: T, user: string) => {
      try {
        if (sameFormValue(value, blank)) await clearFormDraft(user, formKey);
        else await saveFormDraft(user, formKey, value);
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
    },
    [formKey, blank],
  );

  // Put a saved draft back, once.
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    loadFormDraft<Partial<T>>(uid, formKey)
      .then((d) => {
        if (cancelled) return;
        if (d && !sameFormValue(d.data, blank)) {
          setForm({ ...blank, ...d.data });
          setRestoredAt(d.savedAt);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, formKey, blank]);

  // Save after the person stops typing.
  useEffect(() => {
    if (!uid || !ready) return;
    const t = setTimeout(() => void persist(form, uid), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [form, uid, ready, persist]);

  // Flush immediately when the page is hidden/closed or the form goes away.
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      if (cleared.current) return;
      if (l.uid && l.ready) void persist(l.form, l.uid);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persist]);

  const clearDraft = useCallback(() => {
    cleared.current = true;
    setRestoredAt(null);
    if (uid) void clearFormDraft(uid, formKey).catch(() => undefined);
  }, [uid, formKey]);

  const discardDraft = useCallback(() => {
    setForm(blank);
    clearDraft();
  }, [blank, clearDraft]);

  return {
    form,
    setForm,
    restoredAt,
    hasDraft: !sameFormValue(form, blank),
    saveFailed,
    clearDraft,
    discardDraft,
  };
}
