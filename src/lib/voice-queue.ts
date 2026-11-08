// ---------------------------------------------------------------------------
// WORKER VOICE — device queue. Honest by construction.
//
//   saved_on_device  -> the text is on THIS phone. MineGuard has NOT received it.
//   sending          -> a send is in progress.
//   needs_attention  -> the server answered and something must change (site code, wording).
//   (gone)           -> the server answered "received" or "duplicate". Only then is it sent.
//
// A failed durable write throws NotSavedError (offline-store): callers must say "not saved".
// The queue stores no user id, no email and no session data, so an anonymous item on a shared
// phone contains only what the person typed plus its follow-up code.
// ---------------------------------------------------------------------------
import { storeGet, storeSet } from "./offline-store";
import { sendReport, type QueuedReport, type SendOutcome } from "./voice";

const KEY = "mg.voice.queue.v1";

export async function listQueue(): Promise<QueuedReport[]> {
  return (await storeGet<QueuedReport[]>(KEY)) ?? [];
}
async function save(items: QueuedReport[]): Promise<void> {
  await storeSet(KEY, items);
}

export async function enqueue(item: Omit<QueuedReport, "state" | "attempts" | "savedAt"> & { savedAt?: string }): Promise<QueuedReport> {
  const q = await listQueue();
  const full: QueuedReport = { ...item, savedAt: item.savedAt ?? new Date().toISOString(), state: "saved_on_device", attempts: 0 };
  await save([...q.filter((x) => x.id !== full.id), full]);
  return full;
}
export async function removeFromQueue(id: string): Promise<void> {
  await save((await listQueue()).filter((x) => x.id !== id));
}
async function patch(id: string, p: Partial<QueuedReport>): Promise<void> {
  await save((await listQueue()).map((x) => (x.id === id ? { ...x, ...p } : x)));
}

export type ItemResult = { id: string; outcome: SendOutcome["kind"]; sent: boolean };

let inflight: Promise<ItemResult[]> | null = null;

/**
 * Try to send what is waiting. Single-flight: concurrent callers share one pass, so an item is never
 * posted twice at once. Named/confidential items wait for a signed-in session; anonymous ones do not.
 * An item leaves the queue ONLY when the server says received or duplicate.
 */
export function flushQueue(opts: { signedIn: boolean; send?: (i: QueuedReport) => Promise<SendOutcome>; only?: string }): Promise<ItemResult[]> {
  inflight ??= (async () => {
    const send = opts.send ?? sendReport;
    const out: ItemResult[] = [];
    try {
      for (const item of await listQueue()) {
        if (opts.only && item.id !== opts.only) continue;
        if (item.state === "needs_attention") continue;
        if (item.mode !== "anonymous" && !opts.signedIn) continue;
        await patch(item.id, { state: "sending", attempts: item.attempts + 1 });
        const res = await send(item);
        if (res.kind === "received" || res.kind === "duplicate") {
          await removeFromQueue(item.id);
          out.push({ id: item.id, outcome: res.kind, sent: true });
          continue;
        }
        const attention =
          res.kind === "invalid_site_code" ? "The site code was not accepted. Ask your site for the current code, then send the report again."
          : res.kind === "anonymous_paused" ? "Anonymous reporting is paused for this site. Use a named or confidential report, or speak to your safety officer."
          : res.kind === "invalid" ? res.message
          : res.kind === "forbidden" ? "Your account is not allowed to send to this site."
          : undefined;
        await patch(item.id, attention
          ? { state: "needs_attention", attention }
          : { state: "saved_on_device", attention: res.kind === "rate_limited" ? "MineGuard is limiting reports from this connection for now. It will try again." : undefined });
        out.push({ id: item.id, outcome: res.kind, sent: false });
      }
    } finally {
      inflight = null;
    }
    return out;
  })();
  return inflight;
}

/** What the person should be told about an item, without overstating anything. */
export function describeItem(i: Pick<QueuedReport, "state" | "attention">): string {
  if (i.state === "sending") return "Sending now…";
  if (i.state === "needs_attention") return i.attention ?? "This report needs a change before it can be sent.";
  return i.attention ?? "Saved on this device. MineGuard has not received it yet.";
}
