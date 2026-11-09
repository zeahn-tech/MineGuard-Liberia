import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@/lib/backend-react";
import { api, type ContentDetail, type ContentListItem, type ContentStatus, type PublicContentKind } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { StaffOnly } from "@/components/StaffOnly";
import { ContentText } from "@/components/ContentText";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileStack, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/feedback";

const KIND_LABEL: Record<PublicContentKind, string> = {
  glossary_term: "Glossary term",
  safety_guidance: "Safety guidance",
  announcement: "Announcement",
  statistics: "Statistics",
};
const STATUS_LABEL: Record<ContentStatus, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  approved: "Approved",
  published: "Published",
  archived: "Archived",
};
const NOT_REVIEWED = /no qualified sign-off/i;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const day = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
const fromDay = (v: string) => (v ? Date.parse(v + "T00:00:00Z") : undefined);

/** Ministry staff: author, review, approve, publish and archive public content. Four-eyes, immutability
 *  and permissions are enforced by the database; the buttons here only mirror them. */
export default function ContentAdmin() {
  return (
    <StaffOnly>
      <Inner />
    </StaffOnly>
  );
}

type Note = { title: string; label: string; onConfirm: (note: string, checks?: { accuracy: boolean; completeness: boolean; confidentiality: boolean }) => Promise<void>; needChecks?: boolean };

function Inner() {
  const { user } = useAuth();
  const staff = user?.role === "admin" || user?.role === "supervisor";
  const canPublish = user?.role === "admin";
  const items = useQuery(api.content.list, staff ? {} : "skip");
  const save = useMutation(api.content.save);
  const transition = useMutation(api.content.transition);
  const revise = useMutation(api.content.revise);

  const [status, setStatus] = useState<ContentStatus | "all">("all");
  const [kind, setKind] = useState<PublicContentKind | "all">("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(60);
  const [detail, setDetail] = useState<ContentDetail | null>(null);
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [note, setNote] = useState<(Note & { id: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter(
      (c) => (status === "all" || c.status === status) && (kind === "all" || c.kind === kind) && (!needle || c.title.toLowerCase().includes(needle) || c.slug.includes(needle)),
    );
  }, [items, status, kind, q]);

  if (!staff) {
    return (
      <div className="p-6">
        <EmptyState icon={ShieldAlert} title="Content permission required" why="Public content is managed by Ministry administrators and supervisors." />
      </div>
    );
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toastError(err, { action: "update the content" });
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    try {
      setDetail(await api.content.get(id));
    } catch (err) {
      toastError(err, { action: "open the content" });
    }
  };

  const submitAllDrafts = async () => {
    const drafts = shown.filter((c) => c.status === "draft");
    if (drafts.length === 0) return;
    if (!window.confirm(`Send ${drafts.length} drafts for review? A different reviewer must still approve each one.`)) return;
    await run(async () => {
      for (const d of drafts) await transition({ id: d.id, to: "pending_review" });
    }, `${drafts.length} sent for review.`);
  };

  const actions = (c: ContentListItem) => (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => open(c.id)}>Open</Button>
      {c.status === "draft" && (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing({ id: c.id })}>Edit</Button>
          <Button size="sm" disabled={busy} onClick={() => run(() => transition({ id: c.id, to: "pending_review" }), "Sent for review.")}>Submit for review</Button>
        </>
      )}
      {c.status === "pending_review" && (
        <>
          <Button size="sm" disabled={busy} onClick={() => setNote({ id: c.id, title: "Approve this content", label: "What did you review? (at least 10 characters)", needChecks: true, onConfirm: (n, checks) => transition({ id: c.id, to: "approved", note: n, checks }) })}>Approve</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setNote({ id: c.id, title: "Return to draft", label: "Why does it go back? (at least 10 characters)", onConfirm: (n) => transition({ id: c.id, to: "draft", note: n }) })}>Return</Button>
        </>
      )}
      {c.status === "approved" && (
        <>
          {canPublish && <Button size="sm" disabled={busy} onClick={() => run(() => transition({ id: c.id, to: "published" }), "Published.")}>Publish</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setNote({ id: c.id, title: "Return to draft", label: "Why does it go back? (at least 10 characters)", onConfirm: (n) => transition({ id: c.id, to: "draft", note: n }) })}>Return</Button>
        </>
      )}
      {c.status === "published" && canPublish && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setNote({ id: c.id, title: "Withdraw from public view", label: "Why is it withdrawn? (at least 10 characters)", onConfirm: (n) => transition({ id: c.id, to: "archived", note: n }) })}>Archive</Button>
      )}
      {(c.status === "published" || c.status === "archived") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => revise(c.id), "Draft revision created.")}>Revise</Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="kicker">Public channel</p>
          <h1 className="display text-3xl">Public content</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Only content that is reviewed, approved and published appears on the public pages. The person who
            wrote or last edited a draft cannot approve it. Published content cannot be edited — revise it.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={submitAllDrafts}>Submit shown drafts</Button>
          <Button onClick={() => setEditing({})}>New content</Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search content" placeholder="Search title or slug" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value as ContentStatus | "all")}>
          <option value="all">All statuses</option>
          {(Object.keys(STATUS_LABEL) as ContentStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select aria-label="Kind" className="h-9 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as PublicContentKind | "all")}>
          <option value="all">All kinds</option>
          {(Object.keys(KIND_LABEL) as PublicContentKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </div>

      {items === undefined ? (
        <PageLoading label="content" />
      ) : shown.length === 0 ? (
        <EmptyState icon={FileStack} title="Nothing matches" why="Create content, or change the filters." />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground" aria-live="polite">{shown.length} items</p>
          {shown.slice(0, limit).map((c) => (
            <article key={c.id} className="paper space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{c.title}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{KIND_LABEL[c.kind]}</Badge>
                  <Badge variant={c.status === "published" ? "default" : "secondary"}>{STATUS_LABEL[c.status]}</Badge>
                  <span className="text-xs text-muted-foreground">v{c.version}</span>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {c.authorName ? `Written by ${c.authorName}` : "Imported draft"}
                {c.editedByName && c.editedByName !== c.authorName ? ` · last edited by ${c.editedByName}` : ""}
                {c.source && NOT_REVIEWED.test(c.source) ? " · not yet reviewed" : ""}
              </p>
              {actions(c)}
            </article>
          ))}
          {shown.length > limit && <Button variant="outline" onClick={() => setLimit((n) => n + 60)}>Show more</Button>}
        </div>
      )}

      {detail && <DetailDialog detail={detail} onClose={() => setDetail(null)} />}
      {editing && (
        <EditorDialog
          id={editing.id}
          onClose={() => setEditing(null)}
          onSave={async (args) => {
            await run(() => save(args), "Saved as a draft.");
            setEditing(null);
          }}
        />
      )}
      {note && <NoteDialog n={note} onClose={() => setNote(null)} run={run} />}
    </div>
  );
}

function DetailDialog({ detail, onClose }: { detail: ContentDetail; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{detail.title}</DialogTitle>
          <DialogDescription>
            {KIND_LABEL[detail.kind]} · {STATUS_LABEL[detail.status]} · version {detail.version}
            {detail.category ? ` · ${detail.category}` : ""}
          </DialogDescription>
        </DialogHeader>
        {detail.source && <p className="text-xs text-muted-foreground">Source: {detail.source}</p>}
        {detail.kind === "statistics" ? (
          <ul className="space-y-1 text-sm">
            {(detail.data?.items ?? []).map((i) => <li key={i.label}>{i.label}: <b>{i.value.toLocaleString()}</b> (as of {i.as_of})</li>)}
          </ul>
        ) : (
          <ContentText text={detail.body} />
        )}
        <div>
          <p className="kicker">History</p>
          <ul className="mt-2 space-y-2 text-xs">
            {detail.events.map((e, i) => (
              <li key={i} className="rounded-md bg-muted/40 p-2">
                <b>{e.action}</b> by {e.actor} · {new Date(e.at).toLocaleString()}
                {e.note && <span className="block text-muted-foreground">{e.note}</span>}
                {e.checks && <span className="block text-muted-foreground">Confirmed: accuracy, completeness, confidentiality</span>}
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({ n, onClose, run }: { n: Note & { id: string }; onClose: () => void; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [checks, setChecks] = useState({ accuracy: false, completeness: false, confidentiality: false });
  const ready = text.trim().length >= 10 && (!n.needChecks || (checks.accuracy && checks.completeness && checks.confidentiality));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{n.title}</DialogTitle>
          <DialogDescription>{n.label}</DialogDescription>
        </DialogHeader>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        {n.needChecks && (
          <div className="space-y-2 text-sm">
            {(["accuracy", "completeness", "confidentiality"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">
                <Checkbox checked={checks[k]} onCheckedChange={(v) => setChecks((c) => ({ ...c, [k]: v === true }))} />
                {k === "accuracy" ? "I checked the content is accurate" : k === "completeness" ? "I checked it is complete enough to publish" : "I checked it contains nothing confidential"}
              </label>
            ))}
          </div>
        )}
        <Button
          disabled={!ready}
          onClick={async () => {
            await run(() => n.onConfirm(text.trim(), n.needChecks ? checks : undefined), "Done.");
            onClose();
          }}
        >
          Confirm
        </Button>
      </DialogContent>
    </Dialog>
  );
}

type SaveArgs = Parameters<typeof api.content.save>[0];

function EditorDialog({ id, onClose, onSave }: { id?: string; onClose: () => void; onSave: (a: SaveArgs) => Promise<void> }) {
  const [loaded, setLoaded] = useState<ContentDetail | null | "loading">(id ? "loading" : null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.content.get(id).then(
      (d) => !cancelled && setLoaded(d),
      () => !cancelled && setLoaded(null),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (loaded === "loading") return null;
  return <EditorForm key={id ?? "new"} start={loaded} id={id} onClose={onClose} onSave={onSave} />;
}

function EditorForm({ start, id, onClose, onSave }: { start: ContentDetail | null; id?: string; onClose: () => void; onSave: (a: SaveArgs) => Promise<void> }) {
  const [kind, setKind] = useState<PublicContentKind>(start?.kind ?? "announcement");
  const [title, setTitle] = useState(start?.title ?? "");
  const [slug, setSlug] = useState(start?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(start));
  const [category, setCategory] = useState(start?.category ?? "");
  const [summary, setSummary] = useState(start?.summary ?? "");
  const [body, setBody] = useState(start?.body ?? "");
  const [publishAt, setPublishAt] = useState(day(start?.publishAt ? Date.parse(start.publishAt) : undefined));
  const [expiresAt, setExpiresAt] = useState(day(start?.expiresAt ? Date.parse(start.expiresAt) : undefined));
  const [items, setItems] = useState(start?.data?.items ?? [{ label: "", value: 0, as_of: new Date().toISOString().slice(0, 10) }]);
  const stats = kind === "statistics";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{id ? "Edit draft" : "New content"}</DialogTitle>
          <DialogDescription>Saved as a draft. Nothing is public until it is reviewed, approved and published.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <select aria-label="Kind" disabled={Boolean(id)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as PublicContentKind)}>
            {(Object.keys(KIND_LABEL) as PublicContentKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <Input aria-label="Title" placeholder="Title" value={title} maxLength={150} onChange={(e) => { setTitle(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />
          <Input aria-label="Slug" placeholder="slug-for-this-item" value={slug} maxLength={80} onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true); }} />
          {!stats && <Input aria-label="Category" placeholder="Category (required for glossary terms)" value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} />}
          <Input aria-label="Summary" placeholder="Short summary (optional)" value={summary} maxLength={300} onChange={(e) => setSummary(e.target.value)} />
          {stats ? (
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="grid grid-cols-[1fr_6rem_8rem] gap-2">
                  <Input aria-label={`Label ${i + 1}`} placeholder="Label" value={it.label} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                  <Input aria-label={`Value ${i + 1}`} type="number" min={0} value={it.value} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, value: Number(e.target.value) } : y)))} />
                  <Input aria-label={`As of ${i + 1}`} type="date" value={it.as_of} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, as_of: e.target.value } : y)))} />
                </div>
              ))}
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled={items.length >= 12} onClick={() => setItems((x) => [...x, { label: "", value: 0, as_of: new Date().toISOString().slice(0, 10) }])}>Add figure</Button>
                {items.length > 1 && <Button type="button" size="sm" variant="outline" onClick={() => setItems((x) => x.slice(0, -1))}>Remove last</Button>}
              </div>
            </div>
          ) : (
            <Textarea aria-label="Text" rows={8} placeholder="Plain text. Separate paragraphs with a blank line." value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
          )}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label>Visible from (optional)<Input type="date" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} /></label>
            <label>Expires (optional)<Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></label>
          </div>
        </div>
        <Button
          disabled={title.trim().length < 2 || slug.length < 2}
          onClick={() =>
            onSave({
              id,
              kind,
              slug,
              title: title.trim(),
              summary: summary.trim() || undefined,
              body: stats ? "" : body,
              category: stats ? undefined : category.trim() || undefined,
              data: stats ? { items: items.map((i) => ({ label: i.label.trim(), value: Number(i.value), as_of: i.as_of })) } : undefined,
              publishAt: fromDay(publishAt),
              expiresAt: fromDay(expiresAt),
            })
          }
        >
          Save draft
        </Button>
      </DialogContent>
    </Dialog>
  );
}
