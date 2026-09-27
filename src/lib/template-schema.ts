// ---------------------------------------------------------------------------
// TEMPLATE VALIDATION — §11 configurable inspection design.
//
// The template editor (admin UI) and the data layer (saveTemplate) share
// this validator so the shape contract lives in exactly one place. The
// contract matters beyond storage: the field draft flow keys answers as
// `${sectionIndex}:${questionIndex}` and renders controls from answerType —
// a malformed template would break field submissions at the worst possible
// moment (inspector on-site, offline).
//
// Validation policy: REJECT anything that would not render or would render
// as an unanswerable question. Select questions must carry options (the
// draft select renders only from options); required questions must be
// answerable; labels must be non-empty. Everything else is permitted —
// including arbitrary extra JSON fields, because the schema is stored as
// jsonb and future question types must not require a migration.
// ---------------------------------------------------------------------------

import type { InspectionTemplate, TemplateSection } from "./types";

const ANSWER_TYPES = ["boolean", "text", "select", "number"] as const;

/** Returns null when valid, otherwise a stable error token describing the
 *  first problem found (UI shows these verbatim; tests assert them). */
export function validateTemplateSections(
  sections: unknown,
): string | null {
  if (!Array.isArray(sections)) return "TEMPLATE_SECTIONS_INVALID";
  if (sections.length === 0) return "TEMPLATE_SECTIONS_EMPTY";
  if (sections.length > 30) return "TEMPLATE_SECTIONS_TOO_MANY";

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si] as Partial<TemplateSection> | null;
    if (!sec || typeof sec !== "object") return `TEMPLATE_SECTION_${si}_INVALID`;
    if (typeof sec.title !== "string" || !sec.title.trim())
      return `TEMPLATE_SECTION_${si}_TITLE_REQUIRED`;
    if (sec.title.length > 120) return `TEMPLATE_SECTION_${si}_TITLE_TOO_LONG`;
    if (!Array.isArray(sec.questions)) return `TEMPLATE_SECTION_${si}_QUESTIONS_INVALID`;
    if (sec.questions.length === 0) return `TEMPLATE_SECTION_${si}_QUESTIONS_EMPTY`;
    if (sec.questions.length > 60) return `TEMPLATE_SECTION_${si}_QUESTIONS_TOO_MANY`;

    for (let qi = 0; qi < sec.questions.length; qi++) {
      const q = sec.questions[qi] as Partial<InspectionTemplate["sections"][number]["questions"][number]> | null;
      if (!q || typeof q !== "object") return `TEMPLATE_Q_${si}_${qi}_INVALID`;
      if (typeof q.label !== "string" || !q.label.trim())
        return `TEMPLATE_Q_${si}_${qi}_LABEL_REQUIRED`;
      if (q.label.length > 300) return `TEMPLATE_Q_${si}_${qi}_LABEL_TOO_LONG`;
      if (!ANSWER_TYPES.includes(q.answerType as (typeof ANSWER_TYPES)[number]))
        return `TEMPLATE_Q_${si}_${qi}_ANSWER_TYPE_INVALID`;
      if (q.answerType === "select") {
        if (!Array.isArray(q.options) || q.options.length === 0)
          return `TEMPLATE_Q_${si}_${qi}_OPTIONS_REQUIRED`;
        if (q.options.some((o) => typeof o !== "string" || !o.trim()))
          return `TEMPLATE_Q_${si}_${qi}_OPTIONS_INVALID`;
      }
      if (typeof q.required !== "boolean") return `TEMPLATE_Q_${si}_${qi}_REQUIRED_FLAG_INVALID`;
    }
  }
  return null;
}
