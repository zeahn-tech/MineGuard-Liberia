// ---------------------------------------------------------------------------
// RISK AI PANEL (§18) — the first AI-assisted surface, visibly labeled.
//
// Governance (docs/08_AI_GOVERNANCE.MD), as implemented:
// - The panel renders ONLY the payload from api.ai.explainRiskScore — a
//   server-side, scope-checked, deterministic walkthrough of the existing
//   weighted factors. It never contains client-computed claims.
// - Cite-or-abstain: each sentence names the records behind it; when there
//   are no recorded factors the explainer abstains and the panel says so.
// - Read-only: the panel has no mutation — the authoritative record cannot
//   be touched from here.
// - LABELLED: the "AI-assisted" badge and the payload's disclaimer render
//   unconditionally. The label is part of the data, not a toggle.
// ---------------------------------------------------------------------------

import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Sparkles } from "lucide-react";

export function RiskAiPanel({ siteId }: { siteId: string }) {
  const ai = useQuery(api.ai.explainRiskScore, { siteId });

  if (ai === undefined || ai === null) return null;

  return (
    <div className="mt-4 rounded-none border border-dashed border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-3.5 text-primary" strokeWidth={1.5} />
        <span className="rounded-full border border-primary/40 bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          AI-assisted
        </span>
        <span className="text-xs text-muted-foreground">risk indicator walkthrough</span>
      </div>

      {ai.abstained ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No recorded risk factors for this site — nothing to explain. The
          indicator reflects an empty factor set, not a judgment.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm">{ai.summary}</p>
          <ul className="mt-2 space-y-1.5">
            {ai.sentences.map((s) => (
              <li key={s.factor} className="text-sm">
                <span className="text-muted-foreground">{s.text}</span>{" "}
                {/* break-all: concatenated UUID citations are one long
                    unbroken token — without it they overflow a phone width. */}
                <span className="break-all font-mono text-[10px] text-muted-foreground">
                  ({s.recordIds.join(", ")})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-2 text-xs text-muted-foreground">{ai.disclaimer}</p>
    </div>
  );
}
