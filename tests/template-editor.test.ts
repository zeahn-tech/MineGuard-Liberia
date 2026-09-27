// ---------------------------------------------------------------------------
// TEMPLATE EDITOR — §11: inspection design is configurable without a code
// change.
//
// Two layers are verified:
//
// 1. THE SHAPE CONTRACT (pure): validateTemplateSections is the single
//    authority shared by the editor UI (live feedback) and the data layer
//    (authoritative re-check before persisting). Its refusal tokens are
//    asserted, and every accepted fixture is exactly the shape the field
//    draft flow renders (answers keyed `si:qi`).
//
// 2. THE ADMIN WORKFLOW (through the REAL data layer over the wire bridge):
//    admin creates → publishes → edits (sections/questions) → the edited
//    template is immediately offered to listTemplates (the field flow's
//    query); delete is refused while inspections reference the template;
//    unpublish removes it from the field flow without deleting history.
//    Non-admin identities (inspector, supervisor, operator) cannot save,
//    publish or delete — the editor is admin surface, enforced server-side
//    and audit logged.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { api } from "../src/lib/backend";
import { validateTemplateSections } from "../src/lib/template-schema";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import type { InspectionTemplate, TemplateSection } from "../src/lib/types";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

let clientSwapped = false;

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
});

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

async function expectError(fn: () => Promise<unknown>, token: string) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg).toContain(token);
    return;
  }
  throw new Error(`expected error containing "${token}", but the call succeeded`);
}

/** A minimal valid template: one section, one required boolean question —
 *  exactly the shape the seeded baseline template uses. */
function validSections(): TemplateSection[] {
  return [
    {
      title: "Safety",
      questions: [
        { label: "PPE in use?", answerType: "boolean", required: true },
      ],
    },
  ];
}

// ===========================================================================
// 1. THE SHAPE CONTRACT (pure validator)
// ===========================================================================

describe("template shape contract (validateTemplateSections)", () => {
  test("accepts the exact shape the field draft flow renders", () => {
    const sections: TemplateSection[] = [
      {
        title: "Structural integrity",
        questions: [
          { label: "Decant tower clear of debris?", answerType: "boolean", required: true },
          { label: "Freeboard height (m)", answerType: "number", required: false },
          {
            label: "Embankment condition",
            answerType: "select",
            required: true,
            options: ["Good", "Fair", "Poor"],
          },
          { label: "Observations", answerType: "text", required: false },
        ],
      },
      {
        title: "Water management",
        questions: [{ label: "Silt fence intact?", answerType: "boolean", required: true }],
      },
    ];
    expect(validateTemplateSections(sections)).toBeNull();
  });

  test("rejects: not an array, empty, section without title/questions", () => {
    expect(validateTemplateSections("nope")).toBe("TEMPLATE_SECTIONS_INVALID");
    expect(validateTemplateSections([])).toBe("TEMPLATE_SECTIONS_EMPTY");
    expect(validateTemplateSections([null as unknown as TemplateSection])).toBe(
      "TEMPLATE_SECTION_0_INVALID",
    );
    expect(
      validateTemplateSections([{ title: "  ", questions: [{ label: "x", answerType: "boolean", required: true }] }]),
    ).toBe("TEMPLATE_SECTION_0_TITLE_REQUIRED");
    expect(
      validateTemplateSections([{ title: "S", questions: [] }]),
    ).toBe("TEMPLATE_SECTION_0_QUESTIONS_EMPTY");
  });

  test("rejects: question without label, bad answer type, select without options", () => {
    expect(
      validateTemplateSections([
        { title: "S", questions: [{ label: "", answerType: "boolean", required: true }] },
      ]),
    ).toBe("TEMPLATE_Q_0_0_LABEL_REQUIRED");
    expect(
      validateTemplateSections([
        { title: "S", questions: [{ label: "x", answerType: "range" as "boolean", required: true }] },
      ]),
    ).toBe("TEMPLATE_Q_0_0_ANSWER_TYPE_INVALID");
    expect(
      validateTemplateSections([
        { title: "S", questions: [{ label: "x", answerType: "select", required: true }] },
      ]),
    ).toBe("TEMPLATE_Q_0_0_OPTIONS_REQUIRED");
    expect(
      validateTemplateSections([
        { title: "S", questions: [{ label: "x", answerType: "select", required: true, options: ["", "ok"] }] },
      ]),
    ).toBe("TEMPLATE_Q_0_0_OPTIONS_INVALID");
    expect(
      validateTemplateSections([
        { title: "S", questions: [{ label: "x", answerType: "boolean", required: "yes" as unknown as boolean }] },
      ]),
    ).toBe("TEMPLATE_Q_0_0_REQUIRED_FLAG_INVALID");
  });

  test("second section / third question indices appear in tokens (editor can point at the row)", () => {
    const sections: TemplateSection[] = [
      { title: "A", questions: [{ label: "ok", answerType: "boolean", required: true }] },
      { title: "B", questions: [{ label: "ok", answerType: "boolean", required: false }, { label: "ok2", answerType: "boolean", required: false }, { label: "", answerType: "boolean", required: false }] },
    ];
    expect(validateTemplateSections(sections)).toBe("TEMPLATE_Q_1_2_LABEL_REQUIRED");
  });
});

// ===========================================================================
// 2. THE ADMIN WORKFLOW (data layer over the wire bridge)
// ===========================================================================

describe("template editor workflow (§11)", () => {
  test("admin creates → publishes → template appears in the FIELD flow's listTemplates", async () => {
    setIdentity(f.admin);
    const id = await api.inspections.saveTemplate({
      name: "Tailings Facility Quarterly",
      description: "Editor e2e template",
      active: true,
      sections: [
        {
          title: "Embankment",
          questions: [
            { label: "Visible seepage?", answerType: "boolean", required: true },
            { label: "Condition", answerType: "select", required: true, options: ["Good", "Fair", "Poor"] },
            { label: "Freeboard (m)", answerType: "number", required: false },
            { label: "Notes", answerType: "text", required: false },
          ],
        },
        {
          title: "Water management",
          questions: [{ label: "Decant intact?", answerType: "boolean", required: true }],
        },
      ],
    });
    expect(id).toBeTruthy();

    // Audit rows for create exist.
    const audit = await adminSql(
      `select 1 from public.audit_log where action = 'template.create' and entity_id = '${id}'`,
    );
    expect(audit.length).toBe(1);

    // The field flow (listTemplates filters active=true) offers it immediately.
    setIdentity(f.county); // an inspector sees it too — no admin privilege needed to USE
    const offered = await first(api.inspections.listTemplates());
    const found = offered!.find((t) => t._id === id);
    expect(found).toBeTruthy();
    expect(found!.sections.length).toBe(2);
    expect(found!.sections[0].questions[1].options).toEqual(["Good", "Fair", "Poor"]);
  });

  test("admin edits sections/questions; the edit is what inspectors receive on the next draft", async () => {
    setIdentity(f.admin);
    const id = await api.inspections.saveTemplate({
      name: "Edit-me template",
      active: true,
      sections: validSections(),
    });

    // Edit: add a question and a second section, change an answer type.
    const edited: TemplateSection[] = [
      {
        title: "Safety",
        questions: [
          { label: "PPE in use?", answerType: "boolean", required: true },
          { label: "Crew size on site", answerType: "number", required: false },
        ],
      },
      { title: "Environment", questions: [{ label: "Any discharge?", answerType: "text", required: false }] },
    ];
    await api.inspections.saveTemplate({
      templateId: id,
      name: "Edit-me template (v2)",
      active: true,
      sections: edited,
    });

    // The update audit row exists.
    const audit = await adminSql(
      `select 1 from public.audit_log where action = 'template.update' and entity_id = '${id}'`,
    );
    expect(audit.length).toBe(1);

    // What inspectors are offered IS the edited shape.
    setIdentity(f.national);
    const offered = (await first(api.inspections.listTemplates()))!.find((t) => t._id === id);
    expect(offered!.name).toBe("Edit-me template (v2)");
    expect(offered!.sections[0].questions[1].answerType).toBe("number");
    expect(offered!.sections[1].title).toBe("Environment");
  });

  test("malformed sections are refused by the data layer (UI feedback is not the only guard)", async () => {
    setIdentity(f.admin);
    await expectError(
      () =>
        api.inspections.saveTemplate({
          name: "Broken",
          active: true,
          sections: [{ title: "S", questions: [{ label: "x", answerType: "select", required: true }] }] as TemplateSection[],
        }),
      "TEMPLATE_Q_0_0_OPTIONS_REQUIRED",
    );
    await expectError(
      () => api.inspections.saveTemplate({ name: "", active: true, sections: validSections() }),
      "TEMPLATE_NAME_REQUIRED",
    );
    // Nothing was persisted.
    const rows = await adminSql(`select count(*) as n from public.inspection_templates where name = 'Broken'`);
    expect(Number(rows[0].n)).toBe(0);
  });

  test("unpublish removes the template from the field flow WITHOUT deleting it", async () => {
    setIdentity(f.admin);
    const id = await api.inspections.saveTemplate({
      name: "Unpublish probe",
      active: true,
      sections: validSections(),
    });
    await api.inspections.setTemplateActive({ templateId: id, active: false });

    setIdentity(f.county);
    const offered = await first(api.inspections.listTemplates());
    expect(offered!.some((t) => t._id === id)).toBe(false);

    // The row itself still exists (history/config preserved).
    const row = await adminSql(`select active from public.inspection_templates where id = '${id}'`);
    expect(row.length).toBe(1);
    expect(row[0].active).toBe(false);
  });

  test("delete: refused while inspections reference the template; allowed otherwise", async () => {
    setIdentity(f.admin);
    // The seeded template is referenced by the seeded inspection.
    await expectError(() => api.inspections.deleteTemplate({ templateId: f.template }), "TEMPLATE_IN_USE");

    // An unreferenced template deletes cleanly.
    const id = await api.inspections.saveTemplate({
      name: "Delete-me template",
      active: false,
      sections: validSections(),
    });
    await api.inspections.deleteTemplate({ templateId: id });
    const row = await adminSql(`select 1 from public.inspection_templates where id = '${id}'`);
    expect(row.length).toBe(0);
    const audit = await adminSql(
      `select 1 from public.audit_log where action = 'template.delete' and entity_id = '${id}'`,
    );
    expect(audit.length).toBe(1);
  });

  test("non-admin identities cannot save, publish or delete templates", async () => {
    const args = { name: "Nope", active: true, sections: validSections() };
    for (const uid of [f.national, f.county, f.opA]) {
      setIdentity(uid);
      await expectError(() => api.inspections.saveTemplate(args), "FORBIDDEN");
      await expectError(
        () => api.inspections.setTemplateActive({ templateId: f.template, active: false }),
        "FORBIDDEN",
      );
      await expectError(() => api.inspections.deleteTemplate({ templateId: f.template }), "FORBIDDEN");
    }
    // …but staff/operators still READ templates (using them is their job).
    setIdentity(f.opA);
    const offered = await first(api.inspections.listTemplates());
    expect(offered!.length).toBeGreaterThanOrEqual(1);
  });
});
