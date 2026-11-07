// Shared rendering of an `ai-assist` envelope for guidance + JSA drafting: the label, a
// per-statement provenance badge, notices, and a route to flag an error or ask for human review.
import { Sparkles } from "lucide-react";
import { legalContactEmail } from "@/lib/legal";
import type { AiAssistResponse, AiClaimKind } from "@/lib/ai-assist";

export const KIND_LABEL: Record<AiClaimKind, string> = {
  approved_source: "Approved source",
  general_explanation: "General explanation",
  needs_verification: "Needs verification by a qualified safety professional",
};

export function KindBadge({ kind }: { kind?: AiClaimKind }) {
  const k = kind ?? "needs_verification";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${k === "approved_source" ? "border-primary/50 text-primary" : "border-amber-500/60 text-amber-700 dark:text-amber-400"}`}>
      {KIND_LABEL[k]}
    </span>
  );
}

export function AiHeader({ note }: { note: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Sparkles className="size-3.5 text-primary" strokeWidth={1.5} />
      <span className="rounded-full border border-primary/40 bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">AI-assisted</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}

export function AiFooter({ res }: { res: AiAssistResponse }) {
  const contact = legalContactEmail();
  const href = contact
    ? `mailto:${contact}?subject=${encodeURIComponent("MineGuard AI-assisted output: please review")}&body=${encodeURIComponent(`Capability: ${res.capability}\nGenerated: ${res.generatedAt}\nWhat looks wrong or needs review:\n`)}`
    : null;
  return (
    <>
      {res.notices.length > 0 && (
        <ul className="space-y-1">
          {res.notices.map((n, i) => <li key={i} className="text-xs text-muted-foreground">{n}</li>)}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {res.label}. Generated {new Date(res.generatedAt).toLocaleString()}.{" "}
        {href ? <a className="underline underline-offset-4" href={href}>Report an error or request human review</a> : <span>To report an error or request human review, tell your supervisor or site safety officer.</span>}
      </p>
    </>
  );
}

export function aiFailure(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/429|RATE_LIMITED/i.test(m)) return "You have reached the hourly limit for AI-assisted requests. Please try again later.";
  if (/403|FORBIDDEN|401/i.test(m)) return "AI assistance is not available to your account.";
  return "AI assistance could not be reached right now. Nothing was changed. The reference tabs and your own work still function.";
}
