// ---------------------------------------------------------------------------
// SAFETY GUIDANCE ASSISTANT (Implementation Phase 3, capability A).
//
// DETERMINISTIC retrieval over the reviewed MineGuard reference content in
// guidance-content.ts. No model is called, nothing is generated, nothing is
// written, and no database record is read: the "knowledge base" is a static,
// versioned module. Every statement returned is a verbatim excerpt of that
// content and cites its entry id, so cite-or-abstain applies unchanged.
//
// Provenance is explicit on every claim (`kind`):
//   approved_source     — only once REVIEW.approvedBy names a person;
//   needs_verification  — everything else, INCLUDING the content as shipped,
//                         because the repository records no sign-off.
// `general_explanation` exists in the contract for a future approved provider;
// this module never produces it.
//
// The assistant never: declares a mine/site/area safe, states a legal or
// regulatory requirement, replaces site emergency procedures, or decides for anyone.
// ---------------------------------------------------------------------------

import { AiError, type Claim, type ClaimKind } from "./contract.ts";
import type { Draft } from "./capabilities.ts";
import { detectInjection } from "./injection.ts";
import { EMERGENCY_CONTACTS, FIRST_AID, GLOSSARY, IMMEDIATE_ACTIONS, PPE, REVIEW } from "./guidance-content.ts";

export const MAX_GUIDANCE_QUERY = 300;
const MAX_RESULTS = 5;

const STOP = new Set(["the", "and", "for", "are", "what", "does", "how", "who", "why", "when", "where", "with", "from", "that", "this", "mean", "means", "meaning", "about", "tell", "explain", "define", "definition", "what's", "can", "should", "need", "needs", "use", "used", "please", "term", "word", "have", "has", "was", "you", "your", "our", "any", "all", "get", "got", "into", "its"]);

export function tokens(q: string): string[] {
  const out = q.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).map((t) => t.replace(/^-+|-+$/g, "")).filter((t) => t.length >= 3 && !STOP.has(t));
  return [...new Set(out)];
}

const EMERGENCY_WORDS = /\b(emergency|sos|evacuat\w*|muster|accident|injur\w*|trapped|collapse|explosion|help|urgent)\b/i;
const REGULATORY = /\b(law|legal|illegal|regulat\w*|compl(y|iance|iant)|statut\w*|permit|licen[cs]e|fine|penalt\w*|standard|iso|osha|msha|required by|allowed|permitted|mandatory)\b/i;
const DECLARE_SAFE = /\b(is|are|was|were|declare|certify|confirm|can you say|tell me)\b[^.?]{0,60}\b(safe|safe to (enter|work|proceed)|ok to (enter|work)|cleared?)\b/i;
const SCOPE_WORDS = /\b(mine|pit|site|area|shaft|tunnel|adit|stope|workings?|bench|level)\b/i;

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Scored { id: string; score: number; text: string; type: "glossary" | "ppe" | "firstaid" }

function score(hay: string, toks: string[], weight: number): number {
  const h = hay.toLowerCase();
  let s = 0;
  for (const t of toks) if (h.includes(t)) s += weight;
  return s;
}

export function safetyGuidance(queryRaw: unknown): Draft {
  if (typeof queryRaw !== "string" || queryRaw.trim().length === 0) throw new AiError("BAD_REQUEST", "query must be a non-empty string");
  if (queryRaw.length > MAX_GUIDANCE_QUERY) throw new AiError("BAD_REQUEST", `query is limited to ${MAX_GUIDANCE_QUERY} characters`);

  const retrieved = new Set<string>();
  const notices: string[] = [];
  const injection = detectInjection(queryRaw);
  if (injection.length) notices.push("Instruction-like text in the question was ignored; it was used only as search words.");

  // The assistant does not certify safety — refuse the question, do not search around it.
  if (DECLARE_SAFE.test(queryRaw) && SCOPE_WORDS.test(queryRaw)) {
    return {
      claims: [], data: null, retrieved, notices,
      abstainReason: "This assistant cannot say whether a mine, site or work area is safe. That is a decision for a qualified, authorised person at the site. In an emergency follow your site's approved emergency procedure.",
      injectionFlagged: injection.length > 0,
    };
  }

  const toks = tokens(queryRaw);
  const kind: ClaimKind = REVIEW.approvedBy ? "approved_source" : "needs_verification";
  const claims: Claim[] = [];
  const matches: { id: string; type: string; title: string }[] = [];
  const emergency = EMERGENCY_WORDS.test(queryRaw);

  if (emergency) {
    for (const a of IMMEDIATE_ACTIONS) retrieved.add(a.id);
    claims.push({
      text: `Immediate actions (from the MineGuard emergency screen): ${IMMEDIATE_ACTIONS.map((a) => `${a.order}. ${a.text}`).join("; ")}.`,
      citations: IMMEDIATE_ACTIONS.map((a) => a.id),
      kind,
    });
    for (const c of EMERGENCY_CONTACTS) retrieved.add(c.id);
    claims.push({
      text: `Contacts listed in the app: ${EMERGENCY_CONTACTS.map((c) => `${c.name} — ${c.number}`).join("; ")}.`,
      citations: EMERGENCY_CONTACTS.map((c) => c.id),
      kind,
    });
    matches.push({ id: "ref:immediate", type: "emergency", title: "Immediate actions and contacts" });
    notices.push("In an emergency, follow your site's approved emergency procedure and contact the site emergency number. This assistant does not replace it, raise an alarm, or call anyone.");
  }

  const scored: Scored[] = [];
  if (toks.length) {
    for (const g of GLOSSARY) {
      const s = score(g.term, toks, 10) + score(g.short, toks, 3) + score(g.definition, toks, 1) + (toks.some((t) => g.term.toLowerCase() === t) ? 20 : 0);
      if (s > 0) scored.push({ id: g.id, score: s, type: "glossary", text: `Glossary — ${g.term} (${g.category}): ${g.definition}` });
    }
    for (const p of PPE) {
      const s = score(p.name, toks, 10) + score(p.description, toks, 2) + score(p.when, toks, 1);
      if (s > 0) scored.push({ id: p.id, score: s, type: "ppe", text: `PPE — ${p.name}: ${p.description} ${p.when}${p.mandatory === "always" ? " (always required on site per the guide)" : " (task-specific per the guide)"}.` });
    }
    for (const f of FIRST_AID) {
      const s = score(f.title, toks, 12) + score(f.steps.join(" "), toks, 1);
      if (s > 0) scored.push({ id: f.id, score: s, type: "firstaid", text: `First aid — ${f.title}: ${f.steps.map((st, i) => `${i + 1}. ${st}`).join(" ")}` });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = scored.slice(0, MAX_RESULTS);
  for (const t of top) {
    retrieved.add(t.id);
    claims.push({ text: clip(t.text), citations: [t.id], kind });
    matches.push({ id: t.id, type: t.type, title: t.text.split(":")[0] });
  }
  if (scored.length > top.length) notices.push(`Showing the ${top.length} best matches of ${scored.length}; refine the question to narrow it.`);

  if (top.some((t) => t.type === "firstaid")) {
    notices.push("First-aid steps are a summary for awareness. They do not replace training or a qualified first aider; call for medical help.");
  }
  if (REGULATORY.test(queryRaw)) {
    notices.push("Needs verification by a qualified safety professional: questions about legal, regulatory, permit or standards requirements cannot be answered from this reference content, which states none. Ask your safety officer or the responsible authority.");
  }
  if (!REVIEW.approvedBy) {
    notices.push("The reference content has not yet been signed off by a named qualified safety professional, so every statement is shown as needing verification.");
  }

  if (claims.length === 0) {
    return {
      claims: [], data: null, retrieved, notices,
      abstainReason: "No matching entry was found in the MineGuard reference content (glossary, PPE guide, first-aid and emergency guides). Rephrase using a mining term or PPE item, or ask your safety officer. Nothing has been guessed.",
      injectionFlagged: injection.length > 0,
    };
  }
  return {
    claims, retrieved, notices, abstainReason: null,
    data: { matches, source: REVIEW.source, signedOffBy: REVIEW.approvedBy, signedOffOn: REVIEW.approvedOn },
    injectionFlagged: injection.length > 0,
  };
}
