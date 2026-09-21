import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { ScrollText } from "lucide-react";

export default function Audit() {
  const entries = useQuery(api.stats.recentAuditLog, {});

  return (
    <div className="space-y-6">
      <header>
        <p className="kicker">Accountability</p>
        <h1 className="display text-3xl">Audit log</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Append-only record of consequential actions across the platform: who, what,
          when. Entries are written by the server on every state-changing operation.
        </p>
      </header>

      {entries === undefined ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="paper p-10 text-center text-sm text-muted-foreground">
          No audit entries yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Actor</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e._id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="max-w-[180px] truncate px-4 py-3 text-xs">
                    {e.actorLabel}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{e.action}</span>
                  </td>
                  <td className="px-4 py-3">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
