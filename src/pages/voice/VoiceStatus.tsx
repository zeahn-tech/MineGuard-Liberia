// Public follow-up. No sign-in, and nothing here asks who you are. It shows a stage and any update the
// reviewers wrote for the reporter. It deliberately cannot show anything else.
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicHeader } from "@/components/PublicHeader";
import { lookupFollowUp, parseAnyFollowUpCode, type FollowUpStatus } from "@/lib/voice";

export default function VoiceStatus() {
  const [raw, setRaw] = useState("");
  const [res, setRes] = useState<FollowUpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const look = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setRes(null);
    if (!parseAnyFollowUpCode(raw)) return setErr("That does not look like a follow-up code. It starts with WV (company report) or MV (Ministry report) and has 24 letters and numbers.");
    setBusy(true);
    try { setRes(await lookupFollowUp(raw)); }
    catch { setErr("The check could not be completed. Nothing was changed. Try again when you are connected."); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PublicHeader width="2xl"><Link className="text-sm underline" to="/voice">Worker Voice</Link></PublicHeader>
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Check a Worker Voice report</h1>
          <p className="text-sm text-muted-foreground">Enter the follow-up code you were given when you sent your report. You do not need to sign in or say who you are.</p>
        </header>
        <form onSubmit={look} className="space-y-2">
          <Label htmlFor="wv-code">Follow-up code</Label>
          <Input id="wv-code" value={raw} onChange={(e) => setRaw(e.target.value)} autoComplete="off" autoCapitalize="characters" placeholder="WV-XXXX-… or MV-XXXX-…" />
          <Button type="submit" disabled={busy || !raw.trim()}>{busy ? "Checking…" : "Check"}</Button>
        </form>
        {err && <p role="alert" className="text-sm">{err}</p>}
        {res && res.status === "rate_limited" && <p role="alert" className="text-sm">Too many checks from this connection. Please wait a while and try again.</p>}
        {res && !res.found && res.status !== "rate_limited" && <p role="status" className="text-sm">No report matches that code. Check it for mistakes. Codes cannot be looked up by name or any other detail.</p>}
        {res?.found && (
          <section className="space-y-2 border border-border p-4" aria-live="polite">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stage</p>
            <p className="text-lg font-semibold">{res.stage}</p>
            <p className="text-xs text-muted-foreground">Last change: {res.lastChange}</p>
            {res.update ? <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Update from the reviewers{res.updateOn ? ` (${res.updateOn})` : ""}</p><p className="text-sm">{res.update}</p></div> : <p className="text-sm text-muted-foreground">There is no update written for you yet.</p>}
          </section>
        )}
        <section className="space-y-1 border border-border p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What you can and cannot see here</p>
          <p>You can see the stage and any update the reviewers chose to write for you. This works for reports to your company (WV codes) and to the Ministry (MV codes).</p>
          <p>You cannot see the reviewers&apos; notes, who is handling it, how it was rated, evidence or witnesses. Those stay inside the investigation.</p>
          <p>Anyone who has your code can see this page for your report, so keep it private.</p>
        </section>
      </div>
    </>
  );
}
