// ---------------------------------------------------------------------------
// INCIDENT INSIGHTS PANEL (Implementation Phase 3) — on-request incident trend
// summaries and potential-pattern review prompts.
//
// Everything shown comes from the `ai-assist` Edge Function (askAiAssistant):
// figures are computed server-side from records the signed-in account may
// already see. Nothing runs until the person asks, nothing is written, and
// nothing here can approve, close or authorise anything.
//
//   * LABELLED: the payload's own label renders unconditionally.
//   * NOT A VERDICT: patterns are prompts for a qualified person to look into.
//   * HUMAN REVIEW: a visible route to flag an error or ask for review —
//     a pre-filled email when the deployment has a contact address
//     (VITE_LEGAL_CONTACT_EMAIL), otherwise a plain instruction. The email
//     carries the capability and timestamp only, never the content.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { askAiAssistant, type AiAssistResponse } from "@/lib/ai-assist";
import { legalContactEmail } from "@/lib/legal";

type Mode = "incident_trend_summary" | "risk_patterns";
type State =
  | { phase: "idle" }
  | { phase: "loading"; mode: Mode }
  | { phase: "done"; mode: Mode; res: AiAssistResponse }
  | { phase: "error"; mode: Mode; message: string };

const TITLES: Record<Mode, string> = {
  incident_trend_summary: "Incident trend summary (last 90 days)",
  risk_patterns: "Potential patterns for review (last 12 months)",
};

function failureMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/429|RATE_LIMITED/i.test(m)) return "You have reached the hourly limit for AI-assisted requests. Please try again later.";
  if (/403|FORBIDDEN/i.test(m)) return "AI assistance is not available to your account.";
  return "The AI-assisted summary could not be produced right now. Your records are unaffected; try again later or review the incident list directly.";
}

export function IncidentInsightsPanel() {
  const [state, setState] = useState<State>({ phase: "idle" });
  const contact = legalContactEmail();

  const run = async (mode: Mode) => {
    setState({ phase: "loading", mode });
    try {
      const res = await askAiAssistant(mode === "incident_trend_summary" ? { capability: mode, days: 90 } : { capability: mode, months: 12 });
      setState({ phase: "done", mode, res });
    } catch (e) {
      setState({ phase: "error", mode, message: failureMessage(e) });
    }
  };

  const busy = state.phase === "loading";
  const res = state.phase === "done" ? state.res : null;
  const reviewHref = res && contact
    ? `mailto:${contact}?subject=${encodeURIComponent("MineGuard AI-assisted output: please review")}&body=${encodeURIComponent(`Capability: ${res.capability}\nGenerated: ${res.generatedAt}\nWhat looks wrong or needs review:\n`)}`
    : null;

  return (
    <section className="rounded-none border border-dashed border-primary/40 bg-primary/5 p-3" aria-label="AI-assisted incident insights">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-3.5 text-primary" strokeWidth={1.5} />
        <span className="rounded-full border border-primary/40 bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">AI-assisted</span>
        <span className="text-xs text-muted-foreground">Figures are calculated from the incidents you can see. Nothing runs until you ask.</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run("incident_trend_summary")}>Summarise incident trends</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run("risk_patterns")}>Look for patterns to review</Button>
      </div>

      {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">Working on it…</p>}
      {state.phase === "error" && <p role="alert" className="mt-3 text-sm">{state.message}</p>}

      {res && state.phase === "done" && (
        <div className="mt-3 space-y-2">
          <h3 className="text-sm font-medium">{TITLES[state.mode]}</h3>
          {res.abstained ? (
            <p className="text-sm text-muted-foreground">{res.abstainReason}</p>
          ) : (
            <ul className="space-y-2">
              {res.claims.map((c, i) => (
                <li key={i} className="text-sm text-muted-foreground">{c.text}</li>
              ))}
            </ul>
          )}
          {res.notices.length > 0 && (
            <ul className="space-y-1">
              {res.notices.map((n, i) => (
                <li key={i} className="text-xs text-muted-foreground">{n}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {res.label}. Generated {new Date(res.generatedAt).toLocaleString()}. Verify against the source records and have a qualified safety professional review before acting.{" "}
            {reviewHref ? (
              <a className="underline underline-offset-4" href={reviewHref}>Report an error or request human review</a>
            ) : (
              <span>To report an error or request human review, tell your supervisor or site safety officer.</span>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
