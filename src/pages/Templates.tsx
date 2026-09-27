// ---------------------------------------------------------------------------
// INSPECTION TEMPLATE EDITOR — §11: inspection design is configurable
// without a code change.
//
// Admin surface: create/edit templates (sections → questions → answer
// types boolean/text/select/number, required flags, select options),
// publish/unpublish, delete (refused while inspections reference the
// template). The shape contract lives in src/lib/template-schema.ts and is
// enforced BOTH live in the editor and authoritatively in the data layer
// (saveTemplate re-validates before persisting — the UI is never trusted).
//
// The stored shape is exactly what the field draft flow renders
// (answers keyed `${sectionIndex}:${questionIndex}`), so a template saved
// here is immediately usable on-device, offline included.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api, validateTemplateSections } from "@/lib/backend";
import type { InspectionTemplate, TemplateSection } from "@/lib/types";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FileCheck2,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

function blankQuestion(): TemplateSection["questions"][number] {
  return { label: "", answerType: "boolean", required: true };
}

function blankSection(): TemplateSection {
  return { title: "", questions: [blankQuestion()] };
}

function friendlyError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : "";
  if (msg.startsWith("TEMPLATE_Q_") || msg.startsWith("TEMPLATE_SECTION_")) {
    return `Template shape invalid: ${msg}`;
  }
  if (msg.includes("TEMPLATE_NAME_REQUIRED")) return "Give the template a name.";
  if (msg.includes("TEMPLATE_IN_USE"))
    return "This template is used by existing inspections — it cannot be deleted (history keeps its shape). Unpublish it instead.";
  return fallback;
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

export function TemplateList() {
  const templatesQ = useQuery(api.inspections.listTemplatesAll);
  const setActive = useMutation(api.inspections.setTemplateActive);
  const remove = useMutation(api.inspections.deleteTemplate);
  const [busy, setBusy] = useState(false);

  const templates = templatesQ ?? [];

  const toggleActive = async (t: InspectionTemplate) => {
    setBusy(true);
    try {
      await setActive({ templateId: t._id, active: !t.active });
      toast.success(t.active ? "Template unpublished — no longer offered for new drafts." : "Template published — offered for new drafts.");
    } catch (err) {
      toast.error(friendlyError(err, "Could not change the template."));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (t: InspectionTemplate) => {
    setBusy(true);
    try {
      await remove({ templateId: t._id });
      toast.success("Template deleted.");
    } catch (err) {
      toast.error(friendlyError(err, "Could not delete the template."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="kicker">Administration</p>
          <h1 className="display text-2xl">Inspection templates</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Inspection design is data, not code: sections, questions and
            answer types are defined here and immediately offered to field
            inspectors — offline devices included.
          </p>
        </div>
        <Link to="/portal/templates/new">
          <Button disabled={busy}>
            <Plus className="mr-1.5 size-4" strokeWidth={1.5} />
            New template
          </Button>
        </Link>
      </div>

      {templatesQ === undefined && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {templatesQ !== undefined && templates.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No templates yet — create the first one.
        </p>
      )}

      <div className="space-y-3">
        {templates.map((t) => {
          const qCount = t.sections.reduce((n, s) => n + s.questions.length, 0);
          return (
            <Card key={t._id} className="paper rounded-none border-border shadow-none">
              <CardContent className="flex flex-wrap items-center gap-3 pt-4">
                <FileCheck2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {t.name}
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        t.active
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {t.active ? "published" : "unpublished"}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.sections.length} section{t.sections.length === 1 ? "" : "s"} · {qCount} question{qCount === 1 ? "" : "s"}
                    {t.description ? ` · ${t.description}` : ""}
                  </p>
                </div>
                <div className="ml-auto flex gap-2">
                  <Link to={`/portal/templates/${t._id}`}>
                    <Button variant="outline" size="sm" disabled={busy}>
                      Edit
                    </Button>
                  </Link>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleActive(t)}>
                    {t.active ? "Unpublish" : "Publish"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void doDelete(t)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EDITOR
// ---------------------------------------------------------------------------

function TemplateEditorForm({ existing }: { existing?: InspectionTemplate }) {
  const navigate = useNavigate();
  const save = useMutation(api.inspections.saveTemplate);

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [active, setActive] = useState(existing?.active ?? false);
  const [sections, setSections] = useState<TemplateSection[]>(
    existing ? JSON.parse(JSON.stringify(existing.sections)) : [blankSection()],
  );
  const [busy, setBusy] = useState(false);
  const [openSection, setOpenSection] = useState<number>(0);

  // Live validation feedback — the same validator the data layer enforces.
  const validationError = useMemo(() => validateTemplateSections(sections), [sections]);
  const dirty =
    !existing ||
    name !== existing.name ||
    description !== (existing.description ?? "") ||
    active !== existing.active ||
    JSON.stringify(sections) !== JSON.stringify(existing.sections);

  const setSection = (si: number, patch: Partial<TemplateSection>) => {
    setSections((arr) => arr.map((s, i) => (i === si ? { ...s, ...patch } : s)));
  };

  const setQuestion = (si: number, qi: number, patch: Partial<TemplateSection["questions"][number]>) => {
    setSections((arr) =>
      arr.map((s, i) =>
        i === si
          ? { ...s, questions: s.questions.map((q, j) => (j === qi ? { ...q, ...patch } : q)) }
          : s,
      ),
    );
  };

  const addSection = () => {
    setSections((arr) => [...arr, blankSection()]);
    setOpenSection(sections.length);
  };

  const addQuestion = (si: number) => {
    setSection(si, { questions: [...sections[si].questions, blankQuestion()] });
  };

  const moveSection = (si: number, dir: -1 | 1) => {
    const j = si + dir;
    if (j < 0 || j >= sections.length) return;
    const arr = [...sections];
    [arr[si], arr[j]] = [arr[j], arr[si]];
    setSections(arr);
    setOpenSection(j);
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const id = await save({
        templateId: existing?._id,
        name,
        description: description || undefined,
        active,
        sections,
      });
      toast.success(existing ? "Template saved." : "Template created.");
      navigate(`/portal/templates`, { replace: existing ? undefined : true, state: { savedId: id } });
    } catch (err) {
      toast.error(friendlyError(err, "Could not save the template."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link
        to="/portal/templates"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft className="size-3.5" /> All templates
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="kicker">Administration</p>
          <h1 className="display text-2xl">
            {existing ? `Edit: ${existing.name}` : "New inspection template"}
          </h1>
        </div>
        <Button disabled={busy || !dirty || validationError !== null || !name.trim()} onClick={() => void doSave()}>
          {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Save className="mr-1.5 size-4" strokeWidth={1.5} />}
          {existing ? "Save changes" : "Create template"}
        </Button>
      </div>

      {/* Identity */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Template name</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Quarterly Tailings Facility Check"
              disabled={busy}
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-active">Availability</Label>
            <Select
              value={active ? "published" : "draft"}
              onValueChange={(v) => setActive(v === "published")}
              disabled={busy}
            >
              <SelectTrigger id="tpl-active">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Unpublished — not offered for new drafts</SelectItem>
                <SelectItem value="published">Published — offered to field inspectors</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="tpl-desc">Description (optional)</Label>
            <Input
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this inspection covers"
              disabled={busy}
            />
          </div>
        </CardContent>
      </Card>

      {/* Validation feedback */}
      {validationError && (
        <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {validationError}
        </p>
      )}

      {/* Sections */}
      <div className="space-y-3">
        {sections.map((sec, si) => (
          <Card key={si} className="paper rounded-none border-border shadow-none">
            <CardHeader
              className="cursor-pointer pb-2"
              onClick={() => setOpenSection(openSection === si ? -1 : si)}
            >
              <div className="flex items-center gap-2">
                {openSection === si ? (
                  <ChevronUp className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-4 text-muted-foreground" />
                )}
                <CardTitle className="display text-base">
                  Section {si + 1}
                  {sec.title ? `: ${sec.title}` : " (untitled)"}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {sec.questions.length} question{sec.questions.length === 1 ? "" : "s"}
                </span>
                <div className="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="icon" className="size-7" disabled={si === 0 || busy} onClick={() => moveSection(si, -1)} aria-label="Move section up">
                    <ChevronUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7" disabled={si === sections.length - 1 || busy} onClick={() => moveSection(si, 1)} aria-label="Move section down">
                    <ChevronDown className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={busy || sections.length === 1}
                    onClick={() => setSections((arr) => arr.filter((_, i) => i !== si))}
                    aria-label="Remove section"
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            {openSection === si && (
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`sec-title-${si}`}>Section title</Label>
                  <Input
                    id={`sec-title-${si}`}
                    value={sec.title}
                    onChange={(e) => setSection(si, { title: e.target.value })}
                    placeholder="e.g. Structural integrity"
                    disabled={busy}
                    maxLength={120}
                  />
                </div>

                <div className="space-y-2">
                  {sec.questions.map((q, qi) => (
                    <div key={qi} className="rounded border border-border bg-muted/30 p-3">
                      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                        <div className="space-y-1.5">
                          <Label htmlFor={`q-label-${si}-${qi}`}>Question {qi + 1}</Label>
                          <Input
                            id={`q-label-${si}-${qi}`}
                            value={q.label}
                            onChange={(e) => setQuestion(si, qi, { label: e.target.value })}
                            placeholder="e.g. Is the decant tower clear of debris?"
                            disabled={busy}
                            maxLength={300}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`q-type-${si}-${qi}`}>Answer type</Label>
                          <Select
                            value={q.answerType}
                            onValueChange={(v) => setQuestion(si, qi, { answerType: v as TemplateSection["questions"][number]["answerType"] })}
                            disabled={busy}
                          >
                            <SelectTrigger id={`q-type-${si}-${qi}`} className="w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="boolean">Yes / No</SelectItem>
                              <SelectItem value="text">Text</SelectItem>
                              <SelectItem value="number">Number</SelectItem>
                              <SelectItem value="select">Choice list</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {q.answerType === "select" && (
                        <div className="mt-2 space-y-1.5">
                          <Label htmlFor={`q-opts-${si}-${qi}`}>Choices (comma-separated)</Label>
                          <Input
                            id={`q-opts-${si}-${qi}`}
                            value={(q.options ?? []).join(", ")}
                            onChange={(e) =>
                              setQuestion(si, qi, {
                                options: e.target.value.split(",").map((o) => o.trim()).filter((o) => o.length > 0),
                              })
                            }
                            placeholder="Good, Fair, Poor"
                            disabled={busy}
                          />
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-3">
                        <label className="flex items-center gap-1.5 text-sm">
                          <input
                            type="checkbox"
                            checked={q.required}
                            onChange={(e) => setQuestion(si, qi, { required: e.target.checked })}
                            disabled={busy}
                          />
                          Required
                        </label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto text-muted-foreground"
                          disabled={busy || sec.questions.length === 1}
                          onClick={() =>
                            setSection(si, { questions: sec.questions.filter((_, j) => j !== qi) })
                          }
                        >
                          <Trash2 className="mr-1 size-3.5" /> Remove question
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => addQuestion(si)}>
                    <Plus className="mr-1.5 size-3.5" strokeWidth={1.5} />
                    Add question
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        ))}
        <Button variant="outline" disabled={busy} onClick={addSection}>
          <Plus className="mr-1.5 size-4" strokeWidth={1.5} />
          Add section
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Templates already used by submitted inspections are never deleted
        (history keeps its shape) — unpublish them instead to stop new use.
        Every change is attributed in the audit trail. Shape is re-validated
        server-side on save; this editor cannot persist a template the field
        app cannot render.
      </p>
    </div>
  );
}

export function TemplateEditor() {
  const { templateId } = useParams();
  const templatesQ = useQuery(
    templateId ? api.inspections.listTemplatesAll : api.inspections.listTemplatesAll,
    templateId ? { templateId } : undefined,
  );
  const existing = (templatesQ ?? []).find((t) => t._id === templateId);

  if (templateId && templatesQ !== undefined && !existing) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Template not found. It may have been deleted.
        </p>
      </div>
    );
  }

  if (templatesQ === undefined) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  }

  return <TemplateEditorForm key={templateId ?? "new"} existing={templateId ? existing : undefined} />;
}
