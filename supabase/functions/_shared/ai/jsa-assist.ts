// ---------------------------------------------------------------------------
// JSA ASSISTANCE (Implementation Phase 3, capability C).
//
// Drafts PROMPTS for a person completing a Job Safety Analysis: possible
// hazards, possible consequences, suggested control measures, and questions
// that need further assessment. Deterministic keyword matching over the small
// library below; no model is called and nothing is written.
//
// NOT AUTHORITATIVE. The library is general safety knowledge written for this
// feature. It is NOT reviewed content, states no regulation, gives no limits or
// numbers, and is never labelled approved: every suggestion is
// `needs_verification`. It is a checklist to think with, not an assessment of
// the task. It can miss hazards. Whoever prepares the JSA remains responsible
// for identifying them, and a different qualified person must review and
// approve the JSA before the task starts (enforced in the database, migration
// 0043). Nothing here authorises a task.
// ---------------------------------------------------------------------------

import { AiError, type Claim } from "./contract.ts";
import type { Draft } from "./capabilities.ts";
import { detectInjection } from "./injection.ts";
import { PPE } from "./guidance-content.ts";

export const MIN_TASK = 10;
export const MAX_TASK = 500;
const MAX_LOCATION = 120;

export interface HazardPrompt {
  id: string;
  hazard: string;
  keywords: RegExp;
  consequences: string[];
  controls: string[];
  ppe: string[]; // ids from guidance-content PPE
  questions: string[];
}

export const HAZARD_LIBRARY: HazardPrompt[] = [
  {
    id: "jsa:lib:work-at-height", hazard: "Working at height",
    keywords: /\b(height|ladder|scaffold\w*|roof|platform|elevated|fall|climb\w*|bench edge|highwall)\b/i,
    consequences: ["Fall causing serious injury or death", "Dropped tools or materials striking people below"],
    controls: ["Avoid work at height where the task can be done another way", "Use fall prevention first (guardrails, fixed platforms), then fall arrest", "Inspect harness, lanyard and anchor points before use", "Barricade and sign the area below", "Secure tools against dropping"],
    ppe: ["ref:ppe:safety-harness-lanyard", "ref:ppe:hard-hat"],
    questions: ["Is there a competent person to inspect the anchor points?", "How would a person who has fallen be rescued, and how quickly?"],
  },
  {
    id: "jsa:lib:confined-space", hazard: "Confined space or poor ventilation",
    keywords: /\b(confined|tank|vessel|manhole|sump|shaft|tunnel|adit|stope|underground|enclosed)\b/i,
    consequences: ["Oxygen deficiency, toxic or flammable atmosphere", "Entrapment or engulfment", "Difficult rescue"],
    controls: ["Do not enter without the site's entry permit process", "Test the atmosphere before and during entry", "Provide ventilation", "Station a trained standby person outside with a rescue plan", "Maintain communication with the entrant"],
    ppe: ["ref:ppe:dust-mask-respirator", "ref:ppe:cap-lamp"],
    questions: ["Has the atmosphere been tested by a trained person, and is it being monitored?", "Who is the standby person and what is the rescue plan?"],
  },
  {
    id: "jsa:lib:suspended-load", hazard: "Lifting and suspended loads",
    keywords: /\b(lift\w*|crane|hoist\w*|sling\w*|rigging|winch|suspended|load(ing)?|forklift)\b/i,
    consequences: ["Crushing or striking by a falling or swinging load", "Equipment failure"],
    controls: ["Use equipment within its rated capacity and in-date inspection", "Keep everyone out from under the load", "Use a trained, authorised operator and signaller", "Agree clear signals before lifting"],
    ppe: ["ref:ppe:hard-hat", "ref:ppe:steel-toe-safety-boots", "ref:ppe:safety-gloves"],
    questions: ["Is the load weight known, and is the equipment rated for it?", "Is the exclusion zone defined and enforced?"],
  },
  {
    id: "jsa:lib:mobile-equipment", hazard: "Mobile equipment and vehicle interaction",
    keywords: /\b(truck|haul\w*|excavator|loader|dozer|grader|vehicle|reversing|machine\w*|drill rig|dump|traffic|tractor)\b/i,
    consequences: ["Struck or run over by moving equipment", "Collision between vehicles"],
    controls: ["Separate pedestrians from moving equipment", "Make eye contact with the operator before approaching", "Use spotters where visibility is limited", "Wear high-visibility clothing", "Isolate and lock out equipment before maintenance"],
    ppe: ["ref:ppe:hi-visibility-vest", "ref:ppe:hard-hat", "ref:ppe:steel-toe-safety-boots"],
    questions: ["Are there blind spots, and who is acting as spotter?", "Are walkways and equipment routes separated?"],
  },
  {
    id: "jsa:lib:electrical", hazard: "Electrical energy",
    keywords: /\b(electri\w*|power|cable|wiring|generator|switch\w*|live|transformer|voltage|panel)\b/i,
    consequences: ["Electric shock or burns", "Fire or arc flash"],
    controls: ["Treat circuits as live until isolated and proven dead", "Apply lockout and tagout", "Only authorised electricians work on electrical equipment", "Inspect leads and equipment before use"],
    ppe: ["ref:ppe:safety-gloves", "ref:ppe:safety-glasses-goggles", "ref:ppe:steel-toe-safety-boots"],
    questions: ["Has the circuit been isolated, locked out and proven dead by an authorised person?"],
  },
  {
    id: "jsa:lib:explosives", hazard: "Explosives and blasting",
    keywords: /\b(blast\w*|explosive\w*|detonat\w*|charging|misfire|drill and blast|powder)\b/i,
    consequences: ["Premature or unplanned detonation", "Flyrock injury", "Fumes or ground movement"],
    controls: ["Only authorised, trained personnel handle explosives", "Follow the site's approved blasting procedure and exclusion zones", "Account for all explosives and initiators", "Confirm the area is cleared and guarded before firing"],
    ppe: ["ref:ppe:hard-hat", "ref:ppe:hearing-protection", "ref:ppe:safety-glasses-goggles"],
    questions: ["Who is the authorised blaster, and has the exclusion zone been confirmed clear?", "What is the misfire procedure?"],
  },
  {
    id: "jsa:lib:hot-work-fuel", hazard: "Hot work, fire and fuel",
    keywords: /\b(weld\w*|cutting|grind\w*|torch|hot work|spark\w*|fuel|diesel|petrol|flammable|refuel\w*|fire)\b/i,
    consequences: ["Fire or explosion", "Burns", "Toxic fumes"],
    controls: ["Remove or cover flammable materials", "Have suitable fire-fighting equipment ready", "Use the site's hot-work permit process", "Keep a fire watch during and after the work"],
    ppe: ["ref:ppe:face-shield", "ref:ppe:safety-gloves", "ref:ppe:high-visibility-coveralls", "ref:ppe:safety-glasses-goggles"],
    questions: ["Are flammable materials or vapours nearby?", "Is a permit required and in place?"],
  },
  {
    id: "jsa:lib:dust-noise", hazard: "Dust and noise exposure",
    keywords: /\b(dust\w*|crush\w*|screen\w*|noise\w*|loud|drill\w*|silica|conveyor|mill\w*|jackhammer)\b/i,
    consequences: ["Long-term lung damage from dust", "Hearing loss", "Reduced awareness of hazards"],
    controls: ["Suppress dust at the source, such as water or extraction", "Limit time in noisy or dusty areas", "Use respiratory and hearing protection correctly fitted"],
    ppe: ["ref:ppe:dust-mask-respirator", "ref:ppe:hearing-protection", "ref:ppe:safety-glasses-goggles"],
    questions: ["Has the exposure been measured or assessed by a competent person?"],
  },
  {
    id: "jsa:lib:chemicals", hazard: "Chemicals and hazardous substances",
    keywords: /\b(chemical\w*|acid|cyanide|mercury|reagent\w*|solvent\w*|corrosive|toxic|spill\w*|leach\w*|battery)\b/i,
    consequences: ["Skin or eye burns", "Poisoning by inhalation or contact", "Environmental contamination"],
    controls: ["Read the safety data sheet before starting", "Store and label containers correctly", "Have spill containment and wash facilities available", "Use the correct protective equipment"],
    ppe: ["ref:ppe:chemical-resistant-apron", "ref:ppe:safety-gloves", "ref:ppe:safety-glasses-goggles", "ref:ppe:face-shield"],
    questions: ["Is the safety data sheet available and understood by everyone involved?", "Where are the nearest wash and spill-response facilities?"],
  },
  {
    id: "jsa:lib:ground-stability", hazard: "Ground and slope stability",
    keywords: /\b(slope|wall|excavat\w*|trench\w*|rockfall|ground|unstable|collapse|pit|bench|spoil|dig\w*|undercut)\b/i,
    consequences: ["Collapse or rockfall burying or striking people", "Equipment overturning"],
    controls: ["Have a competent person inspect the ground before work", "Scale, support or bench the face as the site procedure requires", "Keep people and equipment back from edges and toes of slopes", "Stop work if conditions change or cracking is seen"],
    ppe: ["ref:ppe:hard-hat", "ref:ppe:cap-lamp", "ref:ppe:steel-toe-safety-boots"],
    questions: ["When was the ground last inspected, and by whom?", "What are the stop-work triggers?"],
  },
  {
    id: "jsa:lib:manual-handling", hazard: "Manual handling and slips, trips, falls",
    keywords: /\b(carry\w*|manual|heavy|lifting by hand|shovel\w*|wet|muddy|slippery|housekeeping|walkway|stairs?|uneven)\b/i,
    consequences: ["Back and musculoskeletal injury", "Slips, trips and falls on the same level"],
    controls: ["Use mechanical aids or team lifts for heavy items", "Keep walkways clear and drained", "Wear appropriate footwear", "Good housekeeping"],
    ppe: ["ref:ppe:steel-toe-safety-boots", "ref:ppe:safety-gloves"],
    questions: ["Can the task be done without carrying by hand?"],
  },
];

/** Questions asked of every task, whatever matched. */
export const GENERAL_QUESTIONS: string[] = [
  "Who has been consulted from the people doing the task, and what do they say could go wrong?",
  "Does this task interact with other work happening at the same time or place?",
  "What would make you stop the task, and who can stop it?",
  "Do the people doing the task have the training and authorisation it needs?",
  "Are emergency contacts, the muster point and rescue arrangements known to everyone involved?",
];

export function jsaSuggestions(args: { task?: unknown; location?: unknown }): Draft {
  const { task, location } = args;
  if (typeof task !== "string") throw new AiError("BAD_REQUEST", "task must be a string");
  const t = task.trim();
  if (t.length < MIN_TASK) throw new AiError("BAD_REQUEST", `task must be at least ${MIN_TASK} characters`);
  if (t.length > MAX_TASK) throw new AiError("BAD_REQUEST", `task is limited to ${MAX_TASK} characters`);
  if (location != null && (typeof location !== "string" || location.length > MAX_LOCATION)) throw new AiError("BAD_REQUEST", `location must be text of at most ${MAX_LOCATION} characters`);

  const retrieved = new Set<string>();
  const notices: string[] = [
    "Draft prompts only. They are general, not reviewed content, and may miss hazards. The person preparing the JSA must identify the real hazards of the task, and a different qualified person must review and approve the JSA before work starts. Nothing here authorises a task.",
  ];
  const injection = detectInjection(t);
  if (injection.length) notices.push("Instruction-like text in the task description was ignored; it was used only to match hazard keywords.");

  // The text is matched against a fixed library; it is never forwarded anywhere.
  const hits = HAZARD_LIBRARY.filter((h) => h.keywords.test(t));
  if (hits.length === 0) {
    return {
      claims: [], data: null, retrieved, notices, injectionFlagged: injection.length > 0,
      abstainReason: "No standard hazard prompts matched this description. That does not mean the task has no hazards. Describe the steps of the task in more detail, or have a qualified person assess it directly.",
    };
  }

  const ppeById = new Map(PPE.map((p) => [p.id, p]));
  const claims: Claim[] = [];
  const suggestions = hits.map((h) => {
    retrieved.add(h.id);
    const ppe = h.ppe.map((id) => ppeById.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    for (const p of ppe) retrieved.add(p.id);
    claims.push({
      text: `Possible hazard — ${h.hazard}. Possible consequences: ${h.consequences.join("; ")}. Suggested controls to consider: ${h.controls.join("; ")}.`,
      citations: [h.id, ...ppe.map((p) => p.id)],
      kind: "needs_verification",
    });
    return {
      id: h.id, hazard: h.hazard, consequences: h.consequences, controls: h.controls,
      ppe: ppe.map((p) => ({ id: p.id, name: p.name })), questions: h.questions,
    };
  });

  return {
    claims, retrieved, notices, abstainReason: null, injectionFlagged: injection.length > 0,
    data: { suggestions, generalQuestions: GENERAL_QUESTIONS, aiAssisted: true, requiresHumanApproval: true },
  };
}
