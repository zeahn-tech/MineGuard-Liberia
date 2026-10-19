// ---------------------------------------------------------------------------
// PROMPT-INJECTION DEFENCE (docs/08 — hard prohibitions 4 and 5).
//
// Defence in depth, strongest layer first:
//   1. Authority never comes from text. Scope is the caller's JWT under RLS;
//      nothing a prompt, a record description, or a document says can widen it.
//   2. The model (when one is ever approved) can only REWORD claims that were
//      computed deterministically from scoped records — see narrate() in
//      provider.ts. It cannot add a record, number or citation, so an
//      injected instruction has nothing to act on.
//   3. Untrusted text is fenced and sanitised before it reaches a model, and
//      instruction-like text is DETECTED and logged (this module). Detection
//      is a signal for reviewers, never the control that keeps data safe.
// ---------------------------------------------------------------------------

const PATTERNS: [string, RegExp][] = [
  ["override-instructions", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|constraints?)\b/i],
  ["role-reassign", /\b(you are now|act as|pretend (to be|you are)|new persona|developer mode|jailbreak)\b/i],
  ["prompt-exfil", /\b(system|hidden|initial) (prompt|instructions?|message)\b/i],
  ["cross-scope", /\b(reveal|show|list|dump|leak|exfiltrate)\b[^.\n]{0,50}\b(other|all|every|another)\b[^.\n]{0,30}\b(tenants?|operators?|sites?|counties|users?|accounts?|records?)\b/i],
  ["privilege-claim", /\b(i am|i'm|as an?|acting as)\b[^.\n]{0,20}\b(admin(istrator)?|root|superuser|service[_ -]?role)\b/i],
  ["sql-ddl", /\b(drop|truncate|alter|delete\s+from|insert\s+into|update)\b[^.\n]{0,20}\b(table|database|schema|from|into|set)\b/i],
  ["sql-union", /\bunion\s+(all\s+)?select\b/i],
  ["sql-comment-chain", /;\s*(--|\/\*)/],
  ["role-markup", /<\/?\s*(system|assistant|user|instructions?|tool)\s*>/i],
  ["secret-seek", /\b(api[_ -]?key|secret|service[_ -]?role|jwt|bearer token|password)\b/i],
];

/** Names of the instruction-like patterns found in `text` (empty = none). */
export function detectInjection(text: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}

/** Remove control characters and fence-lookalikes; collapse whitespace; cap length. */
export function sanitizeUntrusted(text: string, max = 2000): string {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/<<<|>>>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Wrap untrusted text so a model can be told "everything inside is data". */
export function fenceUntrusted(label: string, text: string, max = 2000): string {
  const tag = label.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  return `<<<DATA ${tag}>>>\n${sanitizeUntrusted(text, max)}\n<<<END ${tag}>>>`;
}
