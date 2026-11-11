// Public follow-up. No sign-in, and nothing here asks who you are. It shows a stage and any update the
// reviewers wrote for the reporter. It deliberately cannot show anything else.
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicHeader } from "@/components/PublicHeader";
import { Textarea } from "@/components/ui/textarea";
import { lookupFollowUp, MAX_REPLY, MINISTRY_OPTION_NOTICE, parseAnyFollowUpCode, replyWithCode, type FollowUpStatus } from "@/lib/voice";

export default function VoiceStatus() {
  const [raw, setRaw] = useState("");
  const [res, setRes] = useState<FollowUpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [replyNote, setReplyNote] = useState<string | null>(null);

  const look = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setRes(null);
    if (!parseAnyFollowUpCode(raw)) return setErr("That does not look like a follow-up code. It starts with WV (company report) or MV (Ministry report) and has 24 letters and numbers.");
    setBusy(true);
    try { setRes(await lookupFollowUp(raw)); }
    catch { setErr("The check could not be completed. Nothing was changed. Try again when you are connected."); }
    finally { setBusy(false); }
  };

  const send = async () => {
    if (!res?.channel) return;
    setReplyNote(null);
    const out = await replyWithCode(raw, reply, res.channel);
    if (out === "received") { setReply(""); setReplyNote("Message sent to the reviewers."); setRes(await lookupFollowUp(raw)); }
    else setReplyNote(out === "rate_limited" ? "Too many messages for now. Please try again later." : out === "closed" ? "This report is closed, so it cannot receive more messages." : out === "invalid" ? `Write between 1 and ${MAX_REPLY} characters.` : "The message could not be sent. Nothing was changed.");
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
            {res.messages && res.messages.length > 0 ? (
              <ul className="space-y-2" aria-label="Messages">
                {res.messages.map((m, i) => (
                  <li key={i} className={`border p-2 text-sm ${m.from === "you" ? "border-primary/40" : "border-border"}`}>
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">{m.from === "you" ? "You" : "The reviewers"} · {m.on}</span>
                    {m.text}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">There is no message from the reviewers yet.</p>}
            {res.canReply ? (
              <div className="space-y-1 pt-2">
                <Textarea aria-label="Your message to the reviewers" value={reply} maxLength={MAX_REPLY} onChange={(e) => setReply(e.target.value)} placeholder="Write a message to the reviewers. They will see it with this report, not who you are." />
                <Button size="sm" disabled={!reply.trim()} onClick={() => { void send(); }}>Send message</Button>
                {replyNote && <p role="status" className="text-xs">{replyNote}</p>}
              </div>
            ) : <p className="text-xs text-muted-foreground">This report is closed, so it cannot receive more messages.</p>}
            {res.ministryOption && res.channel === "company" && (
              <div className="space-y-1 border-t border-border pt-2 text-sm">
                <p>{MINISTRY_OPTION_NOTICE}</p>
                <Link className="text-sm underline" to="/voice">Send a report to the Ministry</Link>
              </div>
            )}
          </section>
        )}
        <section className="space-y-1 border border-border p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What you can and cannot see here</p>
          <p>You can see the stage and the messages between you and the reviewers. You can write back; a reply carries no information about who you are. This works for reports to your company (WV codes) and to the Ministry (MV codes).</p>
          <p>You cannot see the reviewers&apos; notes, who is handling it, how it was rated, evidence or witnesses. Those stay inside the investigation.</p>
          <p>Anyone who has your code can see this page for your report, so keep it private.</p>
        </section>
      </div>
    </>
  );
}
