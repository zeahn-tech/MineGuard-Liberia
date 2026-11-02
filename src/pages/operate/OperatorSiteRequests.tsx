// ---------------------------------------------------------------------------
// SITE REQUESTS (company administrators, migration 0037). A company cannot create a
// site — the registry belongs to the Ministry — but it can ASK. The Ministry registers
// the site through its normal validated flow and links it to the request.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { COUNTIES } from "@/lib/counties";
import { Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const EMPTY = { name: "", county: "", district: "", community: "", mineralType: "", latitude: "", longitude: "", notes: "" };
const STATUS_LABEL = { pending: "Waiting for the Ministry", approved: "Approved", rejected: "Declined", cancelled: "Cancelled" } as const;

export default function OperatorSiteRequests() {
  const me = useQuery(api.workforce.myMembership);
  const requests = useQuery(api.siteRequests.list);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me === undefined) return <p className="p-4 text-sm text-muted-foreground md:p-6" role="status">Loading…</p>;
  if (!me || me.orgRole !== "company_admin" || me.memberStatus !== "active") {
    return (
      <div className="p-4 md:p-6">
        <div className="paper flex items-start gap-3 p-6">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm">Requesting a new site is limited to company administrators.</p>
        </div>
      </div>
    );
  }
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const mine = (requests ?? []).filter((r) => r.organizationId === me.organizationId);

  async function submit() {
    setError(null);
    const lat = form.latitude.trim() === "" ? undefined : Number(form.latitude);
    const lng = form.longitude.trim() === "" ? undefined : Number(form.longitude);
    if ((lat === undefined) !== (lng === undefined) || (lat !== undefined && (Number.isNaN(lat) || Number.isNaN(lng!)))) {
      return setError("Give both latitude and longitude as numbers, or leave both empty.");
    }
    setBusy(true);
    try {
      await api.siteRequests.request({
        organizationId: me!.organizationId,
        name: form.name,
        county: form.county,
        district: form.district || undefined,
        community: form.community || undefined,
        mineralType: form.mineralType || undefined,
        latitude: lat,
        longitude: lng,
        notes: form.notes || undefined,
      });
      setForm(EMPTY);
      toast.success("Request sent to the Ministry.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <header className="min-w-0">
        <p className="kicker">{me.organizationName}</p>
        <h1 className="display mt-1 text-2xl sm:text-3xl">Site requests</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Ask the Ministry to register a new site for your company. Once it is approved the site appears in your Sites list.
        </p>
      </header>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">Request a site</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="sr-name">Site name *</Label><Input id="sr-name" value={form.name} maxLength={120} onChange={set("name")} /></div>
            <div className="space-y-1">
              <Label htmlFor="sr-county">County *</Label>
              <Input id="sr-county" value={form.county} list="sr-counties" onChange={set("county")} placeholder="Nimba" />
              <datalist id="sr-counties">{COUNTIES.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="space-y-1"><Label htmlFor="sr-district">District</Label><Input id="sr-district" value={form.district} onChange={set("district")} /></div>
            <div className="space-y-1"><Label htmlFor="sr-community">Community</Label><Input id="sr-community" value={form.community} onChange={set("community")} /></div>
            <div className="space-y-1"><Label htmlFor="sr-mineral">Mineral</Label><Input id="sr-mineral" value={form.mineralType} onChange={set("mineralType")} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor="sr-lat">Latitude</Label><Input id="sr-lat" inputMode="decimal" value={form.latitude} onChange={set("latitude")} /></div>
              <div className="space-y-1"><Label htmlFor="sr-lng">Longitude</Label><Input id="sr-lng" inputMode="decimal" value={form.longitude} onChange={set("longitude")} /></div>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sr-notes">Notes for the Ministry</Label>
            <textarea id="sr-notes" rows={3} maxLength={1000} value={form.notes} onChange={set("notes")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </div>
          <Button disabled={busy || form.name.trim().length < 2 || form.county.trim().length < 2} onClick={() => void submit()}>
            {busy && <Loader2 className="size-4 animate-spin" />} Send request
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Your requests</CardTitle></CardHeader>
        <CardContent>
          {requests === undefined ? <p className="text-sm text-muted-foreground" role="status">Loading requests…</p> : mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="space-y-2">
              {mine.map((r) => (
                <li key={r.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.county}{r.community ? ` · ${r.community}` : ""} · {new Date(r.createdAt).toLocaleDateString()}</p>
                    {r.decisionNote && <p className="mt-1 text-xs">Ministry note: {r.decisionNote}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={r.status === "approved" ? "secondary" : r.status === "rejected" ? "destructive" : "outline"}>{STATUS_LABEL[r.status]}</Badge>
                    {r.status === "pending" && (
                      <Button size="sm" variant="ghost" onClick={() => void api.siteRequests.cancel({ requestId: r.id }).catch((e: Error) => toast.error(e.message))}>Cancel</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
