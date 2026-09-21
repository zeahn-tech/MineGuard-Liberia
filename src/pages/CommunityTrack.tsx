import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Search } from "lucide-react";

const STATUS_COPY: Record<string, string> = {
  submitted: "Received — awaiting triage by authorized personnel.",
  under_review: "Under review — an officer is assessing the report.",
  verified: "Verified — the concern was substantiated during review.",
  dismissed: "Not substantiated — review concluded no further action.",
  referred: "Referred — forwarded to the appropriate authority.",
};

export default function CommunityTrack() {
  const [searchParams, setSearchParams] = useSearchParams();
  const code = searchParams.get("code") ?? "";
  const [input, setInput] = useState(code);

  useEffect(() => {
    setInput(code);
  }, [code]);

  // Only fetch when a code is present (public endpoint, coarse fields only).
  const report = useQuery(
    api.records.trackCommunityReport,
    code ? { trackingCode: code.trim().toUpperCase() } : "skip",
  );

  return (
    <div className="min-h-screen bg-background paper-grain">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4 md:px-8">
          <Link to="/" className="flex items-center gap-2">
            <ShieldCheck className="size-5" strokeWidth={1.5} />
            <span className="display text-base">MineGuard Liberia</span>
          </Link>
          <Link to="/report" className="text-sm text-muted-foreground hover:text-foreground">
            Submit a report
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-12 md:px-8">
        <p className="kicker">Public tracking</p>
        <h1 className="display mt-2 text-3xl">Check report status</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Enter the tracking code you received when submitting a report.
        </p>

        <form
          className="paper mt-6 flex items-end gap-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            setSearchParams(input.trim() ? { code: input.trim().toUpperCase() } : {});
          }}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="code">Tracking code</Label>
            <Input
              id="code"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="CR-XXXXXXXX"
              className="font-mono uppercase"
            />
          </div>
          <Button type="submit">
            <Search className="size-4" /> Look up
          </Button>
        </form>

        {code && (
          <div className="paper mt-6 p-6">
            {report === undefined ? (
              <p className="text-sm text-muted-foreground">Looking up…</p>
            ) : report === null ? (
              <p className="text-sm text-muted-foreground">
                No report found for code <span className="font-mono">{code}</span>.
                Check the code and try again.
              </p>
            ) : (
              <div>
                <p className="kicker">Status for {report.trackingCode}</p>
                <p className="stat-figure mt-2 text-2xl capitalize">
                  {report.status.replace(/_/g, " ")}
                </p>
                <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-muted-foreground">
                  {STATUS_COPY[report.status] ??
                    "Status recorded; contact the program office for detail."}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Submitted {new Date(report.createdAt).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
