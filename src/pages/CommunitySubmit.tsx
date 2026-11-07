import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicHeader } from "@/components/PublicHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck } from "lucide-react";
import { FormField } from "@/components/FormField";
import { toastError, toastProblem } from "@/lib/feedback";
import { COMMUNITY_FIELD_ORDER, validateCommunityReport, type CommunityField } from "@/lib/form-rules";
import { firstInvalid, focusField, hasErrors, type FieldErrors } from "@/lib/validation";

const CATEGORIES = [
  { value: "suspected_illegal_mining", label: "Suspected illegal mining" },
  { value: "pollution", label: "Pollution" },
  { value: "environmental_damage", label: "Environmental damage" },
  { value: "safety_concern", label: "Safety concern" },
  { value: "land_concern", label: "Land concern" },
  { value: "unauthorized_activity", label: "Unauthorized activity" },
] as const;

const COUNTIES = [
  "Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh",
  "Grand Kru", "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba",
  "River Cess", "River Gee", "Sinoe",
];

const COMMUNITY_IDS: Record<CommunityField, string> = {
  category: "category",
  county: "county",
  description: "description",
  phone: "phone",
  latitude: "lat",
  longitude: "lng",
};

export default function CommunitySubmit() {
  const submit = useMutation(api.records.submitCommunityReport);
  const [category, setCategory] = useState<string>("");
  const [county, setCounty] = useState<string>("");
  const [district, setDistrict] = useState("");
  const [community, setCommunity] = useState("");
  const [description, setDescription] = useState("");
  const [phone, setPhone] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ trackingCode: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors<CommunityField>>({});
  const [attempted, setAttempted] = useState(false);

  // Re-check live once the person has tried to submit, so a fixed field clears
  // its own message straight away.
  const recheck = (patch: Partial<Record<CommunityField, string>>) => {
    if (!attempted) return;
    setErrors(validateCommunityReport({ category, county, description, phone, latitude: lat, longitude: lng, ...patch }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validateCommunityReport({ category, county, description, phone, latitude: lat, longitude: lng });
    setErrors(found);
    setAttempted(true);
    if (hasErrors(found)) {
      const first = firstInvalid(found, COMMUNITY_FIELD_ORDER);
      if (first) focusField(COMMUNITY_IDS[first]);
      return;
    }
    setBusy(true);
    try {
      const r = await submit({
        category: category as (typeof CATEGORIES)[number]["value"],
        description: description.trim(),
        county,
        district: district || undefined,
        community: community || undefined,
        latitude: lat ? Number(lat) : undefined,
        longitude: lng ? Number(lng) : undefined,
        contactPhone: phone || undefined,
      });
      setResult(r);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("RATE_LIMITED")) {
        toastProblem({
          what: "Too many reports in a short time.",
          whose: "This is a safety limit, not a fault with your report.",
          fix: "Wait a minute, then press Submit again — what you typed is still here.",
        });
      } else {
        // Nothing is saved on this device for anonymous reports, so be plain
        // that it was NOT sent and that the form still holds their words.
        toastError(err, { action: "send your report" });
      }
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="min-h-screen bg-background paper-grain">
        <div className="mx-auto max-w-2xl px-4 py-20 text-center md:px-8">
          <ShieldCheck className="mx-auto size-10" strokeWidth={1.5} />
          <h1 className="display mt-6 text-3xl">Report received</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Your report has been recorded and queued for review by authorized
            personnel. A report is a concern under assessment — it does not
            constitute a finding or accusation against any party.
          </p>
          <div className="paper mx-auto mt-8 max-w-sm p-6">
            <p className="kicker">Your tracking code</p>
            <p className="stat-figure mt-2 text-3xl tracking-wide">
              {result.trackingCode}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              Save this code. You can check status at any time without signing in.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link to={`/report/track?code=${result.trackingCode}`}>
                Track this report
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/">Back to home</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background paper-grain">
      <PublicHeader width="3xl">
        <Link to="/report/track" className="inline-flex min-h-9 shrink-0 items-center text-sm text-muted-foreground hover:text-foreground">
          Track a report
        </Link>
      </PublicHeader>

      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <p className="kicker">Public reporting channel</p>
        <h1 className="display mt-2 text-3xl md:text-4xl">Report a mining concern</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Use this form to report suspected illegal mining, pollution, environmental
          damage, safety or land concerns. No account is required. Your report will
          be reviewed by authorized personnel — submission starts a human review
          process, not an enforcement action.
        </p>

        <form onSubmit={handleSubmit} noValidate className="paper mt-8 space-y-5 p-6">
          <FormField label="What are you reporting?" required id={COMMUNITY_IDS.category} error={errors.category}>
            {(a11y) => (
              <Select value={category} onValueChange={(v) => { setCategory(v); recheck({ category: v }); }}>
                <SelectTrigger {...a11y}>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <div className="grid gap-4 md:grid-cols-3">
            <FormField label="County" required id={COMMUNITY_IDS.county} error={errors.county}>
              {(a11y) => (
                <Select value={county} onValueChange={(v) => { setCounty(v); recheck({ county: v }); }}>
                  <SelectTrigger {...a11y}>
                    <SelectValue placeholder="Select county" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <div className="space-y-1.5">
              <Label htmlFor="district">District</Label>
              <Input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="community">Community</Label>
              <Input id="community" value={community} onChange={(e) => setCommunity(e.target.value)} />
            </div>
          </div>

          <FormField label="What did you observe?" required id={COMMUNITY_IDS.description} error={errors.description}>
            {(a11y) => (
              <Textarea
                {...a11y}
                rows={5}
                value={description}
                onChange={(e) => { setDescription(e.target.value); recheck({ description: e.target.value }); }}
                placeholder="Describe what you saw, when, and where. Include any landmarks that could help verification."
              />
            )}
          </FormField>

          <div className="grid gap-4 md:grid-cols-3">
            <FormField label="Contact phone (optional)" id={COMMUNITY_IDS.phone} error={errors.phone}>
              {(a11y) => (
                <Input
                  {...a11y}
                  type="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); recheck({ phone: e.target.value }); }}
                  placeholder="+231 77 000 0000"
                />
              )}
            </FormField>
            <FormField label="GPS latitude (optional)" id={COMMUNITY_IDS.latitude} error={errors.latitude}>
              {(a11y) => (
                <Input {...a11y} inputMode="decimal" value={lat}
                  onChange={(e) => { setLat(e.target.value); recheck({ latitude: e.target.value }); }} placeholder="7.4" />
              )}
            </FormField>
            <FormField label="GPS longitude (optional)" id={COMMUNITY_IDS.longitude} error={errors.longitude}>
              {(a11y) => (
                <Input {...a11y} inputMode="decimal" value={lng}
                  onChange={(e) => { setLng(e.target.value); recheck({ longitude: e.target.value }); }} placeholder="-9.5" />
              )}
            </FormField>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            By submitting, you confirm the information is accurate to the best of your
            knowledge. False reports undermine community trust. Contact details are
            optional and are used only for follow-up questions. See our{" "}
            <Link to="/privacy" className="underline underline-offset-4 hover:text-foreground">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link to="/terms" className="underline underline-offset-4 hover:text-foreground">
              Terms of Use
            </Link>
            .
          </p>

          {attempted && Object.values(errors).some(Boolean) && (
            <p role="alert" className="text-sm text-destructive">
              {Object.values(errors).filter(Boolean).length === 1
                ? "One field needs attention"
                : `${Object.values(errors).filter(Boolean).length} fields need attention`}{" "}
              — marked above. Nothing has been sent yet.
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Submitting…" : "Submit report"}
          </Button>
        </form>
      </main>
    </div>
  );
}
