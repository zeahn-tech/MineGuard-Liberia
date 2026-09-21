import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category || !county || !description.trim()) {
      toast.error("Category, county and description are required.");
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
      toast.error(err instanceof Error ? err.message : "Submission failed");
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
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 md:px-8">
          <Link to="/" className="flex items-center gap-2">
            <ShieldCheck className="size-5" strokeWidth={1.5} />
            <span className="display text-base">MineGuard Liberia</span>
          </Link>
          <Link to="/report/track" className="text-sm text-muted-foreground hover:text-foreground">
            Track a report
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <p className="kicker">Public reporting channel</p>
        <h1 className="display mt-2 text-3xl md:text-4xl">Report a mining concern</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Use this form to report suspected illegal mining, pollution, environmental
          damage, safety or land concerns. No account is required. Your report will
          be reviewed by authorized personnel — submission starts a human review
          process, not an enforcement action.
        </p>

        <form onSubmit={handleSubmit} className="paper mt-8 space-y-5 p-6">
          <div className="space-y-1.5">
            <Label htmlFor="category">What are you reporting? *</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="category">
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
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="county">County *</Label>
              <Select value={county} onValueChange={setCounty}>
                <SelectTrigger id="county">
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
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="district">District</Label>
              <Input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="community">Community</Label>
              <Input id="community" value={community} onChange={(e) => setCommunity(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">What did you observe? *</Label>
            <Textarea
              id="description"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what you saw, when, and where. Include any landmarks that could help verification."
              required
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Contact phone (optional)</Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+231 …"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lat">GPS latitude (optional)</Label>
              <Input id="lat" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="7.4" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lng">GPS longitude (optional)</Label>
              <Input id="lng" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="9.5" />
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            By submitting, you confirm the information is accurate to the best of your
            knowledge. False reports undermine community trust. Contact details are
            optional and are used only for follow-up questions.
          </p>

          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Submitting…" : "Submit report"}
          </Button>
        </form>
      </main>
    </div>
  );
}
