import { useState } from "react";
import { Link, useNavigate } from "react-router";
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
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { Plus, MapPin } from "lucide-react";

const COUNTIES = [
  "Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh",
  "Grand Kru", "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba",
  "River Cess", "River Gee", "Sinoe",
];

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
        {isAdmin && <RegisterSiteDialog />}
      </header>

      {!sites ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : sites.length === 0 ? (
        <div className="paper p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No sites registered in your scope yet. An administrator can register sites
            here.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="px-4 py-2.5 font-medium">Code</th>
                <th className="px-4 py-2.5 font-medium">Site</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">County</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Operator</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Open actions</th>
                <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Risk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sites.map((s) => {
                const r = risk?.[s._id];
                return (
                  <tr
                    key={s._id}
                    className="cursor-pointer transition-colors hover:bg-accent/50"
                    onClick={() => navigate(`/portal/sites/${s._id}`)}
                  >
                    <td className="px-4 py-3 font-mono text-xs">{s.code}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground md:hidden">
                        {s.county} · {s.operatorName}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">{s.county}</td>
                    <td className="hidden px-4 py-3 md:table-cell">{s.operatorName}</td>
                    <td className="px-4 py-3">
                      <span className={`stamp ${STATUS_STYLES[s.status] ?? ""}`}>
                        {s.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-right sm:table-cell">
                      {s.openActions}
                    </td>
                    <td className="hidden px-4 py-3 text-right md:table-cell">
                      <span className="stat-figure">{r?.score ?? 0}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RegisterSiteDialog() {
  const create = useMutation(api.sites.create);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    operatorName: "",
    county: "",
    district: "",
    community: "",
    mineralType: "",
    latitude: "",
    longitude: "",
    notes: "",
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.name || !form.operatorName || !form.county) {
      toast.error("Name, operator and county are required.");
      return;
    }
    try {
      await create({
        name: form.name,
        operatorName: form.operatorName,
        county: form.county,
        district: form.district || undefined,
        community: form.community || undefined,
        mineralType: form.mineralType || undefined,
        latitude: form.latitude ? Number(form.latitude) : undefined,
        longitude: form.longitude ? Number(form.longitude) : undefined,
        notes: form.notes || undefined,
      });
      toast.success("Site registered");
      setOpen(false);
      setForm({ name: "", operatorName: "", county: "", district: "", community: "", mineralType: "", latitude: "", longitude: "", notes: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to register site");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> Register site
        </Button>
      </DialogTrigger>
      <DialogContent className="paper max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register mining site</DialogTitle>
          <DialogDescription>
            Creates a registry entry with a generated site code, initially pending
            verification. The action is audit logged.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Site name *</Label>
            <Input value={form.name} onChange={set("name")} placeholder="e.g. Zorzor Corridor Operation" />
          </div>
          <div className="space-y-1.5">
            <Label>Operator organization *</Label>
            <Input value={form.operatorName} onChange={set("operatorName")} placeholder="Exact operator name" />
          </div>
          <div className="space-y-1.5">
            <Label>County *</Label>
            <Input value={form.county} onChange={set("county")} placeholder="Nimba" list="mg-counties" />
            <datalist id="mg-counties">
              {COUNTIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>District</Label>
            <Input value={form.district} onChange={set("district")} />
          </div>
          <div className="space-y-1.5">
            <Label>Community</Label>
            <Input value={form.community} onChange={set("community")} />
          </div>
          <div className="space-y-1.5">
            <Label>Mineral type</Label>
            <Input value={form.mineralType} onChange={set("mineralType")} placeholder="Gold, iron ore, sand…" />
          </div>
          <div className="space-y-1.5">
            <Label>Coordinates (optional)</Label>
            <div className="flex gap-2">
              <Input value={form.latitude} onChange={set("latitude")} placeholder="Lat" />
              <Input value={form.longitude} onChange={set("longitude")} placeholder="Lng" />
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Notes</Label>
            <Input value={form.notes} onChange={set("notes")} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit}>
            <MapPin className="size-4" /> Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
