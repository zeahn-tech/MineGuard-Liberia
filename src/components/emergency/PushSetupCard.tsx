import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BellRing } from "lucide-react";
import { currentPushState, disablePush, enablePush, type PushState } from "@/lib/emergency";

const COPY: Record<PushState, string> = {
  on: "Alert notifications are on for this device. They are best-effort: they can be delayed or missed (no signal, battery saver, blocked notifications).",
  off: "Alert notifications are off for this device. You will only see alerts while MineGuard is open and online.",
  denied: "Notifications are blocked for this site in the browser, so alerts cannot be pushed to this device. Allow notifications in the browser's site settings if you want them.",
  unsupported: "This browser cannot receive push notifications. You will only see alerts while MineGuard is open and online.",
  insecure: "Push notifications need a secure (https) connection.",
  not_configured: "Push notifications are not set up for this MineGuard deployment yet. Alerts appear only while MineGuard is open and online.",
};

export function PushSetupCard() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void currentPushState().then(setState);
  }, []);
  if (!state) return null;
  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (state === "on") {
        await disablePush();
        setState("off");
      } else setState(await enablePush());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change notification settings.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="paper p-4" aria-labelledby="mg-push-h">
      <h3 id="mg-push-h" className="flex items-center gap-2 text-sm font-medium">
        <BellRing className="size-4" strokeWidth={1.5} aria-hidden /> Emergency notifications on this device
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{COPY[state]}</p>
      {err && <p role="alert" className="mt-2 text-xs text-destructive">{err}</p>}
      {(state === "on" || state === "off") && (
        <Button className="mt-3" size="sm" variant="outline" onClick={toggle} disabled={busy}>
          {state === "on" ? "Turn off" : "Turn on notifications"}
        </Button>
      )}
    </section>
  );
}
