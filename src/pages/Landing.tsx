import { Link } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  FileCheck2,
  HeartPulse,
  Landmark,
  Leaf,
  Map,
  MessageSquareWarning,
  ScrollText,
  ShieldCheck,
  WifiOff,
} from "lucide-react";

const MODULES = [
  { icon: Landmark, title: "Site Registry", desc: "A single authoritative ledger of mining sites with county, operator, mineral and lifecycle status." },
  { icon: FileCheck2, title: "Field Inspections", desc: "Configurable templates, GPS capture, and an offline queue so field data is never lost." },
  { icon: HeartPulse, title: "Incident Management", desc: "Fatalities, injuries, near misses and environmental events — documented, not dramatized." },
  { icon: Leaf, title: "Environmental Monitoring", desc: "Observations carry an explicit verification state: observed, measured, verified, unverified, alleged." },
  { icon: MessageSquareWarning, title: "Community Reporting", desc: "A public channel for concerns. Every report is triaged by a human; a report is never a verdict." },
  { icon: Map, title: "National Map", desc: "Sites, incidents and observations on one map, with verified data kept visually distinct from reports." },
  { icon: ScrollText, title: "Audit Log", desc: "Every consequential action is recorded: who, what, when. Append-only, reviewable." },
  { icon: WifiOff, title: "Offline Operations", desc: "Field submissions queue locally and sync with server-side dedupe. Nothing is silently lost." },
];

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  // Public stats: only aggregate, non-sensitive counts. No fake numbers.
  const stats = useQuery(api.stats.publicStats);

  return (
    <div className="min-h-screen bg-background paper-grain">
      {/* Masthead */}
      <header className="border-b border-foreground/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-8">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5" strokeWidth={1.5} />
            <span className="display text-lg">MineGuard Liberia</span>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#capabilities" className="hover:text-foreground">Capabilities</a>
            <a href="#principles" className="hover:text-foreground">Principles</a>
            <Link to="/report" className="hover:text-foreground">Report a concern</Link>
          </nav>
          <div className="flex items-center gap-2">
            {!isLoading && isAuthenticated && (
              <Button asChild variant="outline" size="sm">
                <Link to="/portal">Open portal</Link>
              </Button>
            )}
            <Button asChild size="sm">
              <Link to={isAuthenticated ? "/portal" : "/auth"}>
                {isAuthenticated ? "Command Center" : "Staff sign-in"}
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
        {/* Double editorial rule */}
        <div className="mx-auto max-w-6xl px-4 md:px-8">
          <div className="border-t border-foreground/20" />
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-14 pt-16 md:px-8 md:pt-24">
        <div className="max-w-3xl">
          <p className="kicker">National mining oversight · Government-ready architecture</p>
          <h1 className="display mt-4 text-4xl md:text-6xl">
            Mining oversight, engineered for evidence.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            MineGuard Liberia is a unified platform for authorized personnel to register
            mining sites, document inspections and incidents, track corrective actions,
            monitor environmental conditions, and receive community concerns — with every
            record attributable, time-stamped, and auditable.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link to="/auth">
                Staff sign-in <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/report">Report a community concern</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Designed for potential government adoption. This is not an official Government
            of Liberia system, and no government approval is claimed or implied.
          </p>
        </div>

        {/* Public stats strip — computed from real data, or hidden until data exists */}
        <div className="mt-14 border-y border-border">
          <div className="grid grid-cols-2 divide-x divide-border md:grid-cols-4">
            <Stat label="Registered mining sites" value={stats?.sites} />
            <Stat label="Inspections on record" value={stats?.inspections} />
            <Stat label="Documented incidents" value={stats?.incidents} />
            <Stat label="Community reports received" value={stats?.communityReports} />
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section id="capabilities" className="mx-auto max-w-6xl px-4 py-14 md:px-8">
        <div className="border-t-2 border-foreground/70 pt-3">
          <p className="kicker">Capabilities</p>
          <h2 className="display mt-2 text-3xl md:text-4xl">
            One platform, the full oversight chain.
          </h2>
        </div>
        <div className="mt-10 grid gap-px overflow-hidden rounded-sm border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {MODULES.map((m) => (
            <div key={m.title} className="bg-card p-6">
              <m.icon className="size-5" strokeWidth={1.5} />
              <h3 className="display mt-4 text-base">{m.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Principles */}
      <section id="principles" className="mx-auto max-w-6xl px-4 py-14 md:px-8">
        <div className="border-t-2 border-foreground/70 pt-3">
          <p className="kicker">Operating principles</p>
          <h2 className="display mt-2 text-3xl md:text-4xl">
            Trust is a design requirement.
          </h2>
        </div>
        <div className="mt-10 grid gap-8 md:grid-cols-3">
          {[
            {
              t: "Server-side authorization",
              d: "Access is derived from role, organization, and geographic scope on every request. The interface never grants permission by hiding buttons.",
            },
            {
              t: "Data with provenance",
              d: "Records carry authorship, timestamps, and lifecycle status. History is corrected forward — important records are never silently deleted.",
            },
            {
              t: "Verification before assertion",
              d: "Environmental data distinguishes observed from measured, verified, unverified, and alleged. Community reports remain concerns until a human verifies them.",
            },
          ].map((p) => (
            <div key={p.t} className="border-t border-border pt-4">
              <h3 className="display text-lg">{p.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Public reporting */}
      <section className="mx-auto max-w-6xl px-4 pb-14 md:px-8">
        <div className="border-y border-foreground/80">
          <div className="grid gap-8 p-8 md:grid-cols-2 md:p-12">
            <div>
              <p className="kicker">For communities</p>
              <h2 className="display mt-2 text-2xl md:text-3xl">
                See something? Report it — safely.
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Community members can report suspected illegal mining, pollution, safety
                concerns, or land issues. You receive a tracking code and can follow the
                status. Reports are reviewed by authorized personnel; a report is a
                concern, never an automatic accusation.
              </p>
            </div>
            <div className="flex flex-col justify-center gap-3">
              <Button asChild>
                <Link to="/report">
                  Submit a report <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/report/track">Track an existing report</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between md:px-8">
          <span>
            MineGuard Liberia — v1.0 · Government-ready architecture, designed for
            potential government adoption.
          </span>
          <span>Statistics shown, if any, are computed from live platform data only.</span>
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="px-5 py-6">
      <div className="stat-figure text-3xl">
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
      <div className="kicker mt-1">{label}</div>
    </div>
  );
}
