import { useParams, Link } from "react-router";
import { useQuery, useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ArrowLeft, MapPin, MapPinOff } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SiteLocationPicker } from "@/components/SiteLocationPicker";
import { sourceLabel } from "@/lib/gis";
import { draftFromSite, parsePositionInput, type PositionDraft, EMPTY_POSITION_DRAFT } from "@/lib/site-position";
import type { Id } from "@/lib/compat-types";
import { RiskAiPanel } from "../components/RiskAiPanel";
import { useNow } from "@/hooks/use-now";

export default function SiteDetail() {
  const now = useNow();
  const { siteId } = useParams<{ siteId: string }>();
  const site = useQuery(
    api.sites.get,
    siteId ? { siteId: siteId as Id<"sites"> } : "skip",
  );
  const inspections = useQuery(api.inspections.list);
  const cas = useQuery(
    api.inspections.listSiteCorrectiveActions,
    siteId ? { siteId: siteId as Id<"sites"> } : "skip",
  );
  const incidents = useQuery(api.records.listIncidents);
  const observations = useQuery(api.records.listObservations);
  const risk = useQuery(api.sites.riskScores);
  const setStatus = useMutation(api.sites.setStatus);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [statusOpen, setStatusOpen] = useState(false);
  const [newStatus, setNewStatus] = useState("");
  const updateSite = useMutation(api.sites.update);
  const verifyPosition = useMutation(api.gis.setSiteGeoVerification);
  const [locOpen, setLocOpen] = useState(false);
  const [locDraft, setLocDraft] = useState<PositionDraft>(EMPTY_POSITION_DRAFT);
  const [verifyOn, setVerifyOn] = useState(false);
  const [verifySource, setVerifySource] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);

  if (!siteId) return <p className="text-sm text-muted-foreground">No site selected.</p>;
  if (site === undefined)
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  if (site === null)
    return <p className="py-16 text-center text-sm text-muted-foreground">Site not found or access denied.</p>;

  const siteInspections = (inspections ?? []).filter((i) => i.siteId === siteId);
  const siteIncidents = (incidents ?? []).filter((i) => i.siteId === siteId);
  const siteObs = (observations ?? []).filter((o) => o.siteId === siteId);
  const r = risk?.[siteId];

  const changeStatus = async () => {
    try {
      await setStatus({ siteId: siteId as Id<"sites">, status: newStatus });
      toast.success(`Status set to ${newStatus.replace(/_/g, " ")}`);
      setStatusOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const openLocation = () => {
    setLocDraft(draftFromSite(site));
    setVerifyOn(false);
    setVerifySource("");
    setLocOpen(true);
  };

  const saveLocation = async () => {
    if (savingLoc) return;
    const pos = parsePositionInput(locDraft.latitude, locDraft.longitude);
    if (pos.kind !== "ok") {
      toast.error(pos.kind === "error" ? pos.error : "Set a position first: use your location, pick it on the map, or type it.");
      return;
    }
    if (verifyOn && !verifySource.trim()) {
      toast.error("Say what the position was verified against (for example: surveyed with a GPS receiver).");
      return;
    }
    setSavingLoc(true);
    try {
      await updateSite({
        siteId: siteId as Id<"sites">,
        latitude: pos.latitude,
        longitude: pos.longitude,
        geoSource: locDraft.source,
        geoAccuracyM: locDraft.accuracyM ?? null,
      });
      if (verifyOn) {
        await verifyPosition({
          siteId,
          geoVerified: true,
          source: verifySource.trim(),
          accuracyM: locDraft.accuracyM,
        });
      }
      toast.success(verifyOn ? "Position saved and verified" : "Position saved — it is now on the map");
      setLocOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^[A-Z_]+:\s*/, "") : "Failed to save position");
    } finally {
      setSavingLoc(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/portal/sites">
            <ArrowLeft className="size-4" /> Registry
          </Link>
        </Button>
      </div>

      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="kicker">Site record · {site.code}</p>
          <h1 className="display mt-1 text-3xl">{site.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{site.operatorName}</span>
            <span>{site.county}{site.district ? ` · ${site.district}` : ""}</span>
            {site.mineralType && <span>{site.mineralType}</span>}
            {site.latitude != null && site.longitude != null ? (
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="flex items-center gap-1">
                  <MapPin className="size-3.5" /> {site.latitude.toFixed(4)}, {site.longitude.toFixed(4)}
                </span>
                <span className="text-xs">
                  {site.geoVerified ? "verified" : "unverified"} · {sourceLabel(site.geoSource)}
                  {site.geoAccuracyM !== undefined ? ` · ±${Math.round(site.geoAccuracyM)} m` : ""}
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <MapPinOff className="size-3.5" /> Not on the map — no position yet
              </span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="stamp">{site.status.replace(/_/g, " ")}</span>
            {r && r.score > 0 && (
              <span className="stamp text-destructive">risk {r.score}</span>
            )}
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={openLocation}>
              {site.latitude != null ? "Edit location" : "Set location"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setNewStatus(site.status);
                setStatusOpen(true);
              }}
            >
              Change status
            </Button>
          </div>
        )}
      </header>

      {site.notes && (
        <p className="border-l-2 border-border pl-4 text-sm italic leading-relaxed text-muted-foreground">
          {site.notes}
        </p>
      )}

      {/* Risk factor breakdown — explainable */}
      {r && r.factors.length > 0 && (
        <section>
          <h2 className="display border-b border-border pb-2 text-lg">Risk indicator breakdown</h2>
          <ul className="mt-3 space-y-1.5">
            {r.factors.map((f) => (
              <li key={f.label} className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">{f.label}</span>
                <span className="stat-figure">+{f.points}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between border-t border-border pt-2 text-sm font-medium">
              <span>Total indicator</span>
              <span className="stat-figure">{r.score}</span>
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Decision-support only. Weights are configurable; a score never determines
            guilt or triggers enforcement.
          </p>
          <RiskAiPanel siteId={siteId} />
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <RecordSection title="Inspections">
          {siteInspections.length === 0 ? (
            <Empty text="No inspections recorded for this site." />
          ) : (
            <ul className="divide-y divide-border">
              {siteInspections.map((i) => (
                <li key={i._id} className="py-2.5">
                  <Link to={`/portal/inspections/${i._id}`} className="group flex items-baseline justify-between gap-3">
                    <span className="text-sm group-hover:underline">
                      {new Date(i.createdAt).toLocaleDateString()} · inspection
                    </span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {i.status.replace(/_/g, " ")}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </RecordSection>

        <RecordSection title="Corrective actions">
          {cas === undefined ? (
            <Empty text="Loading…" />
          ) : cas.length === 0 ? (
            <Empty text="No corrective actions for this site." />
          ) : (
            <ul className="divide-y divide-border">
              {cas.map((ca) => (
                <li key={ca._id} className="py-2.5 text-sm">
                  <p>{ca.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="stamp">{ca.status.replace(/_/g, " ")}</span>{" "}
                    due {new Date(ca.dueAt).toLocaleDateString()}
                    {ca.dueAt < now && ca.status !== "closed" && ca.status !== "verified" && (
                      <span className="text-destructive"> · overdue</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </RecordSection>

        <RecordSection title="Incidents">
          {siteIncidents.length === 0 ? (
            <Empty text="No incidents recorded for this site." />
          ) : (
            <ul className="divide-y divide-border">
              {siteIncidents.map((i) => (
                <li key={i._id} className="py-2.5 text-sm">
                  <p>{i.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i.type.replace(/_/g, " ")} · {i.severity} ·{" "}
                    {new Date(i.occurredAt).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </RecordSection>

        <RecordSection title="Environmental observations">
          {siteObs.length === 0 ? (
            <Empty text="No observations recorded for this site." />
          ) : (
            <ul className="divide-y divide-border">
              {siteObs.map((o) => (
                <li key={o._id} className="py-2.5 text-sm">
                  <p>{o.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="stamp">{o.verification}</span>{" "}
                    {o.category.replace(/_/g, " ")} ·{" "}
                    {new Date(o.observedAt).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </RecordSection>
      </div>

      {/* Admin location dialog — capture a real position (GPS / map / typed) */}
      <Dialog open={locOpen} onOpenChange={setLocOpen}>
        <DialogContent className="paper max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{site.latitude != null ? "Edit site location" : "Set site location"}</DialogTitle>
            <DialogDescription>
              {site.name} · {site.code}. The position is what puts this site on the National Map.
              {site.geoVerified && " Moving a verified position removes its verification."}
            </DialogDescription>
          </DialogHeader>
          <SiteLocationPicker value={locDraft} onChange={setLocDraft} disabled={savingLoc} />
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id="verify-position"
                checked={verifyOn}
                onCheckedChange={(v) => setVerifyOn(v === true)}
                disabled={savingLoc}
              />
              <Label htmlFor="verify-position" className="text-sm font-normal leading-snug">
                Mark this position as verified against an authoritative source
              </Label>
            </div>
            {verifyOn && (
              <Input
                value={verifySource}
                onChange={(e) => setVerifySource(e.target.value)}
                placeholder="Verified against… e.g. surveyed with a GPS receiver, 2026-10"
                disabled={savingLoc}
                aria-label="What the position was verified against"
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              Leave unticked unless someone has checked it: a GPS fix or a map click is recorded as an
              unverified claim, and the map shows it that way.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLocOpen(false)} disabled={savingLoc}>
              Cancel
            </Button>
            <Button onClick={saveLocation} disabled={savingLoc}>
              {savingLoc ? "Saving…" : "Save position"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin status dialog */}
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent className="paper">
          <DialogHeader>
            <DialogTitle>Change site status</DialogTitle>
            <DialogDescription>
              Lifecycle changes are audit logged with your identity.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>New status</Label>
            <select
              className="w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
            >
              <option value="active">Active</option>
              <option value="pending_verification">Pending verification</option>
              <option value="suspended">Suspended</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusOpen(false)}>Cancel</Button>
            <Button onClick={changeStatus}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RecordSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="display border-b border-border pb-2 text-lg">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-4 text-sm text-muted-foreground">{text}</p>;
}
