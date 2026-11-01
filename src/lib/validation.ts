// ---------------------------------------------------------------------------
// FORM VALIDATION — small pure helpers so every form flags the exact field,
// inline, with how to fix it (instead of one toast for the whole form).
// ---------------------------------------------------------------------------

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

/** The first field (in on-screen order) that has an error, or null. */
export function firstInvalid<K extends string>(errors: FieldErrors<K>, order: readonly K[]): K | null {
  for (const k of order) if (errors[k]) return k;
  return null;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/** Move keyboard focus to a field by id (after a failed submit). */
export function focusField(id: string): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (el && typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returns an inline message, or undefined when the address looks valid. */
export function emailProblem(value: string): string | undefined {
  const v = value.trim();
  if (!v) return "Enter an email address, like name@company.com.";
  if (!v.includes("@")) return "An email address needs an @, like name@company.com.";
  if (!EMAIL_RE.test(v)) return "That email address looks incomplete — check it, like name@company.com.";
  return undefined;
}

/** Returns an inline message, or undefined when the password is acceptable. */
export function passwordProblem(value: string, min = 6): string | undefined {
  if (!value) return `Enter a password of at least ${min} characters.`;
  if (value.length < min) return `Use at least ${min} characters — you have ${value.length}.`;
  return undefined;
}

export function confirmProblem(password: string, confirm: string): string | undefined {
  if (!confirm) return "Type the password again to confirm it.";
  if (password !== confirm) return "These two passwords don't match — retype the second one.";
  return undefined;
}

/** A required text field: says what to enter, not just that it is "required". */
export function requiredProblem(value: string, what: string, example?: string): string | undefined {
  if (value.trim()) return undefined;
  return example ? `Enter ${what}, for example ${example}.` : `Enter ${what}.`;
}

/** A required choice from a list. */
export function chooseProblem(value: string, what: string): string | undefined {
  return value ? undefined : `Choose ${what} from the list.`;
}

/** Optional whole number >= 0 (headcounts etc.). */
export function countProblem(value: string, what: string): string | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d+$/.test(value.trim())) return `${what} must be a whole number, like 0, 1 or 12.`;
  if (Number(value) > 100000) return `${what} looks too large — check the number.`;
  return undefined;
}
