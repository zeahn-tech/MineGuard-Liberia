// ---------------------------------------------------------------------------
// COMPANY PROFILE (migration 0037). Every company member can read their company's
// details; a company administrator maintains the contact details. The registered NAME
// and the STATUS are the Ministry's (the name is what every site is registered under),
// so they are shown but not editable here.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type Draft = { contactEmail: string; contactPhone: string; address: string; website: string; description: string };

export default function OperatorCompany() {
  const me = useQuery(api.workforce.myMembership);
  const profile = useQuery(api.companyProfile.get, me ? { organizationId: me.organizationId } : "skip");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me === undefined || (me && profile === undefined)) return <p className="p-4 text-sm text-muted-foreground md:p-6" role="status">Loading…</p>;
  if (!me || !profile) return <div className="p-4 md:p-6"><div className="paper p-6 text-sm">No company is linked to this account.</div></div>;

  const canEdit = me.orgRole === "company_admin" && me.memberStatus === "active" && me.companyStatus === "approved";
  const base: Draft = {
    contactEmail: profile.contactEmail ?? "",
    contactPhone: profile.contactPhone ?? "",
    address: profile.address ?? "",
    website: profile.website ?? "",
    description: profile.description ?? "",
  };
  const value = draft ?? base;
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...value, [k]: e.target.value });
  const dirty = draft !== null && (Object.keys(base) as (keyof Draft)[]).some((k) => draft[k].trim() !== base[k]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.companyProfile.update({ organizationId: profile!.id, ...value });
      setDraft(null);
      toast.success("Company profile saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <header className="min-w-0">
        <p className="kicker">Company</p>
        <h1 className="display mt-1 text-2xl break-words sm:text-3xl">{profile.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={profile.status === "approved" ? "secondary" : "destructive"}>{profile.status.replace(/_/g, " ")}</Badge>
          <span>The registered name and status are managed by the Ministry.</span>
        </div>
      </header>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">Contact and description</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {canEdit ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="co-email">Contact email</Label>
                  <Input id="co-email" type="email" inputMode="email" value={value.contactEmail} onChange={set("contactEmail")} placeholder="office@company.com" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="co-phone">Contact phone</Label>
                  <Input id="co-phone" inputMode="tel" value={value.contactPhone} onChange={set("contactPhone")} placeholder="+231 …" />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="co-address">Address</Label>
                <Input id="co-address" value={value.address} maxLength={300} onChange={set("address")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="co-web">Website</Label>
                <Input id="co-web" inputMode="url" value={value.website} onChange={set("website")} placeholder="https://" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="co-desc">About the company</Label>
                <textarea id="co-desc" rows={4} maxLength={1000} value={value.description} onChange={set("description")}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              </div>
              <Button disabled={!dirty || saving} onClick={() => void save()}>
                {saving && <Loader2 className="size-4 animate-spin" />} Save changes
              </Button>
            </>
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {([["Contact email", base.contactEmail], ["Contact phone", base.contactPhone], ["Address", base.address], ["Website", base.website]] as const).map(([k, v]) => (
                <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words">{v || "—"}</dd></div>
              ))}
              <div className="min-w-0 sm:col-span-2"><dt className="text-xs text-muted-foreground">About</dt><dd className="whitespace-pre-wrap break-words">{base.description || "—"}</dd></div>
            </dl>
          )}
          {!canEdit && <p className="text-xs text-muted-foreground">Only a company administrator can change these details.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
