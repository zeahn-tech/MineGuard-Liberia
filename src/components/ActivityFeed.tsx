// A company's or site's activity history (migration 0038): newest first, "Show more" pages
// with the server's own (time, id) cursor so nothing is skipped or repeated.
import { Button } from "@/components/ui/button";
import { api } from "@/lib/backend";
import type { ActivityItem } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

type Cursor = { atRaw: string; id: string };
interface Loaded {
  scope: string;
  items: ActivityItem[];
  next: Cursor | null;
}

export function ActivityFeed({ organizationId, siteId }: { organizationId: string; siteId?: string }) {
  const scope = `${organizationId}:${siteId ?? ""}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.activity
      .page({ organizationId, siteId })
      .then((p) => {
        if (!live) return;
        setLoaded({ scope, items: p.items, next: p.next });
        setFailed(null);
      })
      .catch((e: unknown) => {
        if (live) setFailed(e instanceof Error ? e.message : "The history could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [organizationId, siteId, scope, retry]);

  async function more(cursor: Cursor) {
    setBusy(true);
    try {
      const p = await api.activity.page({ organizationId, siteId, before: cursor });
      setLoaded((cur) => (cur && cur.scope === scope ? { scope, items: [...cur.items, ...p.items], next: p.next } : cur));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "The history could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {failed}{" "}
        <button type="button" className="underline" onClick={() => { setFailed(null); setRetry((n) => n + 1); }}>Try again</button>
      </p>
    );
  }
  const current = loaded && loaded.scope === scope ? loaded : null;
  if (!current) return <p className="text-sm text-muted-foreground" role="status">Loading history…</p>;
  if (current.items.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border">
        {current.items.map((a) => (
          <li key={a.id} className="flex min-w-0 flex-col gap-0.5 p-3 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <span className="min-w-0 break-words">
              <span className="font-medium">{a.subject}</span> {a.what}
              {a.detail ? <span className="text-muted-foreground"> — {a.detail}</span> : null}
              <span className="block text-xs text-muted-foreground">by {a.who}</span>
            </span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(a.at).toISOString()}>
              {new Date(a.at).toLocaleString()}
            </time>
          </li>
        ))}
      </ul>
      {current.next && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void more(current.next!)}>
          {busy && <Loader2 className="size-3.5 animate-spin" />} Show more
        </Button>
      )}
    </div>
  );
}
