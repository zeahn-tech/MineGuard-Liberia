import { useCallback, useEffect, useRef, useState } from "react";
import { COUNTIES } from "@/lib/counties";
import { Link, useNavigate, useSearchParams } from "react-router";
import { SiteLocationPicker } from "@/components/SiteLocationPicker";
import {
  EMPTY_POSITION_DRAFT,
  parsePositionInput,
  type PositionDraft,
} from "@/lib/site-position";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { Plus, MapPin, MapPinOff, ChevronLeft, ChevronRight, Landmark } from "lucide-react";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { FormField } from "@/components/FormField";
import { FieldError } from "@/components/ui/field";
import { useFormDraft } from "@/hooks/use-form-draft";
import { suggestFromList } from "@/lib/did-you-mean";
import { toastError, toastSuccess } from "@/lib/feedback";
import { SITE_FIELD_ORDER, validateSite, type SiteField } from "@/lib/form-rules";
import { firstInvalid, focusField, hasErrors, type FieldErrors } from "@/lib/validation";


const STATUS_STYLES: Record<string, string> = {
  active: "text-foreground",
  pending_verification: "text-muted-foreground",
  suspended: "text-destructive",
  closed: "text-muted-foreground",
};

export default function Sites() {
  const sites = useQuery(api.sites.list);
  const risk = useQuery(api.sites.riskScores);
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [registerOpen, setRegisterOpen] = useState(false);

  // Company filter (kept in the address, so a company page can link straight to its sites).
  const [params, setParams] = useSearchParams();
  const companyId = params.get("company") ?? "";
  const companyOptions = Array.from(
    new Map(
      (sites ?? [])
        .filter((s) => s.organizationId)
        .map((s) => [s.organizationId as string, s.operatorName] as const),
    ),
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const visible = (sites ?? []).filter((s) => !companyId || s.organizationId === companyId);

  // Horizontal panning for the wide sites table on small screens. The scroll
  // container is native-touch-scrollable; the edge buttons pan it for mouse
  // users and give an explicit affordance that more columns exist.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  const pan = (dir: -1 | 1) => {
    scrollRef.current?.scrollBy({ left: dir * 220, behavior: "smooth" });
  };

  // Re-evaluate arrow visibility when data arrives or the viewport resizes.
  useEffect(() => {
    updateScrollState();
    window.addEventListener("resize", updateScrollState);
    return () => window.removeEventListener("resize", updateScrollState);
  }, [updateScrollState, sites, risk]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker">Registry</p>
          <h1 className="display text-3xl">Mining sites</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scope-filtered automatically: you only ever see sites your role and
            geography permit.
          </p>
        </div>
        {isAdmin && <RegisterSiteDialog open={registerOpen} onOpenChange={setRegisterOpen} />}
      </header>

      {sites && sites.length > 0 && companyOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="company-filter" className="text-xs text-muted-foreground">Company</Label>
          <Select
            value={companyId || "all"}
            onValueChange={(v) => setParams(v === "all" ? {} : { company: v }, { replace: true })}
          >
            <SelectTrigger id="company-filter" className="w-full sm:w-72" aria-label="Filter by company">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All companies</SelectItem>
              {companyOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
          {companyId && (
            <span className="text-xs text-muted-foreground">
              {visible.length} site{visible.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}

      {!sites ? (
        <PageLoading shape="list" label="sites" />
      ) : sites.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No sites registered yet"
          why={
            isAdmin
              ? "Inspections, incidents and observations all hang off a registered site, so nothing else can be recorded until one exists."
              : "Inspections, incidents and observations all hang off a registered site. An administrator registers sites — once they do, the ones in your area appear here."
          }
          action={isAdmin ? { label: "Register the first site", onClick: () => setRegisterOpen(true) } : undefined}
        />
      ) : (
        <div className="relative overflow-hidden rounded-sm border border-border">
          {/* Edge-pan buttons: shown only while more content exists in that
              direction. On touch devices native horizontal swipe also works. */}
          {canScrollLeft && (
            <button
              type="button"
              className="absolute left-1 top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm backdrop-blur transition-colors hover:bg-accent"
              onClick={() => pan(-1)}
              aria-label="Scroll table left"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          {canScrollRight && (
            <button
              type="button"
              className="absolute right-1 top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm backdrop-blur transition-colors hover:bg-accent"
              onClick={() => pan(1)}
              aria-label="Scroll table right"
            >
              <ChevronRight className="size-4" />
            </button>
          )}
          <div
            ref={scrollRef}
            className="scrollbar-hide overflow-x-auto"
            onScroll={updateScrollState}
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            <div className="min-w-max">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left">
                    <th className="px-4 py-2.5 font-medium">Code</th>
                    <th className="px-4 py-2.5 font-medium">Site</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">County</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">Company</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-3 text-right">Open actions</th>
                    <th className="px-4 py-3 text-right">Risk</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visible.map((s) => {
                    const r = risk?.[s._id];
                    return (
                      <tr
                        key={s._id}
                        tabIndex={0}
                        aria-label={`Open site ${s.name}`}
                        className="cursor-pointer transition-colors hover:bg-accent/50 focus-visible:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => navigate(`/portal/sites/${s._id}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/portal/sites/${s._id}`);
                          }
                        }}
                      >
                        <td className="px-4 py-3 font-mono text-xs">{s.code}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{s.name}</div>
                          {(s.latitude == null || s.longitude == null) && (
                            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                              <MapPinOff className="size-3" /> Not on the map — no position yet
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground md:hidden">
                            {s.county} · {s.operatorName}
                          </div>
                        </td>
                        <td className="hidden px-4 py-3 md:table-cell">{s.county}</td>
                        <td className="hidden px-4 py-3 md:table-cell">
                          {isAdmin && s.organizationId ? (
                            <Link
                              className="underline-offset-2 hover:underline"
                              to={`/portal/companies/${s.organizationId}`}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              {s.operatorName}
                            </Link>
                          ) : (
                            s.operatorName
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`stamp ${STATUS_STYLES[s.status] ?? ""}`}>
                            {s.status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="px-2 py-1 text-xs underline-offset-2 hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/portal/sites/${s._id}`);
                            }}
                          >
                            Open
                          </Button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="px-2 py-1 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/portal/sites/${s._id}`);
                            }}
                          >
                            <span className="stat-figure text-xs">{r?.score ?? 0}</span>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function blankSite() {
  return { name: "", operatorName: "", county: "", district: "", community: "", mineralType: "", notes: "" };
}

const SITE_IDS: Record<SiteField, string> = {
  name: "site-name",
  operatorName: "site-company",
  county: "site-county",
};

function RegisterSiteDialog({
  open: openProp,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const create = useMutation(api.sites.create);
  const companies = useQuery(api.companies.approvedOptions);
  const navigate = useNavigate();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [saving, setSaving] = useState(false);
  const { form, setForm, restoredAt, hasDraft, clearDraft, discardDraft } = useFormDraft(
    "site-registration",
    blankSite(),
  );
  const [position, setPosition] = useState<PositionDraft>(EMPTY_POSITION_DRAFT);
  const [errors, setErrors] = useState<FieldErrors<SiteField>>({});
  const [positionError, setPositionError] = useState<string | undefined>();
  const [attempted, setAttempted] = useState(false);
  const set = (k: keyof ReturnType<typeof blankSite>) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = { ...form, [k]: e.target.value };
    setForm(next);
    if (attempted) setErrors(validateSite(next));
  };
  // A typo in the county is pointed out, but never blocks the form: the list is
  // a guide, and rejecting free text could lock out a legitimate spelling.
  const countyHint = suggestFromList(form.county, COUNTIES);

  const submit = async () => {
    if (saving) return;
    const found = validateSite(form);
    setErrors(found);
    setAttempted(true);
    // Validate the position BEFORE saving: a site that can never be mapped is
    // worse than a slower form.
    const pos = parsePositionInput(position.latitude, position.longitude);
    setPositionError(pos.kind === "error" ? pos.error : undefined);
    if (hasErrors(found)) {
      const first = firstInvalid(found, SITE_FIELD_ORDER);
      if (first) focusField(SITE_IDS[first]);
      return;
    }
    if (pos.kind === "error") return;
    setSaving(true);
    try {
      const id = await create({
        name: form.name,
        operatorName: form.operatorName,
        county: form.county,
        district: form.district || undefined,
        community: form.community || undefined,
        mineralType: form.mineralType || undefined,
        ...(pos.kind === "ok"
          ? {
              latitude: pos.latitude,
              longitude: pos.longitude,
              geoSource: position.source,
              geoAccuracyM: position.accuracyM,
            }
          : {}),
        notes: form.notes || undefined,
      });
      toastSuccess({
        title: `${form.name.trim()} registered.`,
        reassure: "It starts as pending verification and the registration is in the audit log.",
        next: id ? { label: "Open site", onClick: () => navigate(`/portal/sites/${id}`) } : undefined,
      });
      setOpen(false);
      setForm(blankSite());
      clearDraft();
      setPosition(EMPTY_POSITION_DRAFT);
      setErrors({});
      setPositionError(undefined);
      setAttempted(false);
    } catch (e) {
      toastError(e, { action: "register the site" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> {hasDraft ? "Resume draft" : "Register site"}
        </Button>
      </DialogTrigger>
      <DialogContent className="paper max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register mining site</DialogTitle>
          <DialogDescription>
            Creates a registry entry with a generated site code, initially
            pending verification. The action is audit logged.
          </DialogDescription>
        </DialogHeader>
        {restoredAt && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-sm border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span>
              Restored your unsaved draft from{" "}
              {new Date(restoredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}. The map position
              isn't kept in drafts — set it again.
            </span>
            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={discardDraft}>
              Start over
            </button>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Site name" required id={SITE_IDS.name} error={errors.name} className="sm:col-span-2">
            {(a11y) => (
              <Input {...a11y} value={form.name} onChange={set("name")} placeholder="e.g. Zorzor Corridor Operation" />
            )}
          </FormField>
          <div className="space-y-1.5">
            {companies !== undefined && companies.length === 0 ? (
              <>
                <Label>Operator company *</Label>
                <p className="rounded-md border p-2 text-xs text-muted-foreground">
                  No approved company yet. <Link className="underline" to="/portal/companies">Register one in Companies</Link> first.
                </p>
              </>
            ) : (
              <FormField
                label="Operator company"
                required
                id={SITE_IDS.operatorName}
                error={errors.operatorName}
                hint={
                  <>
                    Only registered, approved companies are listed. New company?{" "}
                    <Link className="underline" to="/portal/companies">Register it first</Link>.
                  </>
                }
              >
                {(a11y) => (
                  <Select
                    value={form.operatorName}
                    onValueChange={(v) => {
                      const next = { ...form, operatorName: v };
                      setForm(next);
                      if (attempted) setErrors(validateSite(next));
                    }}
                  >
                    <SelectTrigger {...a11y} aria-label="Operator company"><SelectValue placeholder="Choose a registered company" /></SelectTrigger>
                    <SelectContent>
                      {(companies ?? []).map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            )}
          </div>
          <FormField
            label="County"
            required
            id={SITE_IDS.county}
            error={errors.county}
            hint={
              countyHint ? (
                <>
                  Did you mean{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2"
                    onClick={() => {
                      const next = { ...form, county: countyHint };
                      setForm(next);
                      if (attempted) setErrors(validateSite(next));
                    }}
                  >
                    {countyHint}
                  </button>
                  ?
                </>
              ) : undefined
            }
          >
            {(a11y) => (
              <>
                <Input {...a11y} value={form.county} onChange={set("county")} placeholder="Nimba" list="mg-counties" />
                <datalist id="mg-counties">
                  {COUNTIES.map((c) => <option key={c} value={c} />)}
                </datalist>
              </>
            )}
          </FormField>
          <div className="space-y-1.5">
            <Label htmlFor="site-district">District</Label>
            <Input id="site-district" value={form.district} onChange={set("district")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-community">Community</Label>
            <Input id="site-community" value={form.community} onChange={set("community")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-mineral">Mineral type</Label>
            <Input id="site-mineral" value={form.mineralType} onChange={set("mineralType")} placeholder="Gold, iron ore, sand…" />
          </div>
          <div className="space-y-1.5">
            <Label>Map position (optional)</Label>
            <SiteLocationPicker value={position} onChange={(p) => { setPosition(p); setPositionError(undefined); }} disabled={saving} autoLocate />
            {positionError && <FieldError>{positionError}</FieldError>}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="site-notes">Notes</Label>
            <Input id="site-notes" value={form.notes} onChange={set("notes")} />
          </div>
        </div>
        {attempted && (Object.values(errors).some(Boolean) || positionError) && (
          <p role="alert" className="text-sm text-destructive">
            Some fields need attention — marked above. Nothing has been saved yet.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Registering…" : (<><MapPin className="size-4" /> Register</>)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
