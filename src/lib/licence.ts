// Ministry licence number rules — a mirror of public.mg_validate_licence / mg_licence_format_recognised (0065), used only
// for instant feedback. The database is the authority.

/** Uppercase, spaces and hyphens removed, "/" kept — the form uniqueness is judged on. */
export function normaliseLicence(raw: string): string {
  return raw.trim().replace(/[\s-]/g, "").toUpperCase();
}

/** Hard rule: returns what is wrong, or undefined when the number may be saved. */
export function licenceProblem(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return "Enter the Ministry licence number.";
  if (/^APL\s*-/i.test(v)) return "“APL-…” is a cadastre application number, not a licence number. Enter the licence number issued by the Ministry.";
  if (/^CLC\s*-/i.test(v)) return "“CLC-…” is a licence category code, not a licence number. Enter the licence number issued by the Ministry.";
  const n = normaliseLicence(v);
  if (n.length < 5 || n.length > 30) return "The licence number must be 5 to 30 characters (spaces and hyphens are ignored).";
  if (!/^[A-Z0-9/]+$/.test(n)) return "Use letters, digits and “/” only.";
  if (!/[0-9]/.test(n)) return "The licence number must contain at least one digit.";
  return undefined;
}

/** Soft rule (a warning, never a block): the two shapes seen so far, from unofficial sources. */
export function licenceFormatRecognised(raw: string): boolean {
  const n = normaliseLicence(raw);
  return /^[A-Z]{3}[0-9]{4}\/[0-9]{2}$/.test(n) || /^MEL[0-9]{7}$/.test(n);
}

export const LICENCE_FORMAT_WARNING = "Format not recognised, please double-check.";
