// ---------------------------------------------------------------------------
// SITE REQUESTS — Ministry review (administrators, migration 0037). Approving registers
// the site through the normal validated registration flow (code, coordinates,
// provenance), then links it to the request. Declining needs a reason the company sees.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import type { SiteRequest } from "@/lib/types";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

function Row({ r }: { r: SiteRequest }) {
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");

  async function approve() {
    setBusy(true);
    try {
      await api.siteRequests.approve(r);
      toast.success(`${r.name} registered for ${r.companyName}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve.");
    } finally {
      setBusy(false);
    }
  }
  async function decline() {
    setBusy(true);
    try {
      await api.siteRequests.reject({ requestId: r.id, note });
      toast.success("Request declined.");
      setDeclining(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not decline.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{r.name}</p>
            <p className="text-xs text-muted-foreground">
              {r.companyName} · {r.county}{r.district ? ` · ${r.district}` : ""}{r.community ? ` · ${r.community}` : ""}
              {r.mineralType ? ` · ${r.mineralType}` : ""}
            </p>
            {r.latitude !== undefined && <p className="text-xs text-muted-foreground">Position {r.latitude}, {r.longitude}</p>}
            {r.notes && <p className="mt-1 whitespace-pre-wrap break-words text-xs">{r.notes}</p>}
            {r.decisionNote && <p className="mt-1 text-xs">Decision note: {r.decisionNote}</p>}
          </div>
          <Badge variant={r.status === "approved" ? "secondary" : r.status === "pending" ? "outline" : "destructive"}>{r.status}</Badge>
        </div>
        {r.status === "approved" && r.siteId && (
          <Link className="text-xs underline" to={`/portal/sites/${r.siteId}`}>Open the registered site</Link>
        )}
        {r.status === "pending" && !declining && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void approve()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Approve and register
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeclining(true)}><X className="size-3.5" /> Decline…</Button>
          </div>
        )}
        {r.status === "pending" && declining && (
          <div className="space-y-2">
            <Label htmlFor={`note-${r.id}`}>Reason (the company will see this)</Label>
            <Input id={`note-${r.id}`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={busy || note.trim().length < 5} onClick={() => void decline()}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} Decline request
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SiteRequests() {
  const { user } = useAuth();
  const requests = useQuery(api.siteRequests.list);
  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <div className="paper flex items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <p className="text-sm">Reviewing site requests is limited to Ministry administrators.</p>
      </div>
    );
  }
  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const done = (requests ?? []).filter((r) => r.status !== "pending" && r.status !== "cancelled").slice(0, 30);

  return (
    <div className="min-w-0 space-y-6">
      <header>
        <p className="kicker">Administration</p>
        <h1 className="display mt-1 text-2xl sm:text-3xl">Site requests</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Companies ask; you register. Approving creates the site in Mining sites.</p>
      </header>
      {requests === undefined ? <p className="text-sm text-muted-foreground" role="status">Loading…</p> : (
        <>
          <section className="space-y-3" aria-label="Waiting for review">
            <h2 className="text-sm font-semibold">Waiting for review ({pending.length})</h2>
            {pending.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting.</p> : pending.map((r) => <Row key={r.id} r={r} />)}
          </section>
          {done.length > 0 && (
            <section className="space-y-3" aria-label="Decided">
              <h2 className="text-sm font-semibold">Recently decided</h2>
              {done.map((r) => <Row key={r.id} r={r} />)}
            </section>
          )}
        </>
      )}
    </div>
  );
}
