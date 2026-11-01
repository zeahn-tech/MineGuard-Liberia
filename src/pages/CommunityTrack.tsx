import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicHeader } from "@/components/PublicHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { FormField } from "@/components/FormField";
import { NoResults } from "@/components/NoResults";
import { PageLoading } from "@/components/PageLoading";
import { normalizeTrackingCode, suggestTrackingCode, trackingCodeProblem } from "@/lib/tracking-code";
import { focusField } from "@/lib/validation";

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
  // Keep the text box in step with the URL's ?code= (e.g. a pasted link or
  // back/forward navigation) by adjusting state while rendering — React's
  // documented alternative to an effect that only copies a prop into state.
  const [syncedCode, setSyncedCode] = useState(code);
  if (code !== syncedCode) {
    setSyncedCode(code);
    setInput(code);
  }

  // Only fetch when a code is present (public endpoint, coarse fields only).
  // The code is tidied (case, spaces, missing "CR-") before it is looked up, so
  // harmless slips don't read as "not found".
  const lookup = normalizeTrackingCode(code);
  const report = useQuery(
    api.records.trackCommunityReport,
    lookup ? { trackingCode: lookup } : "skip",
  );
  const [inputError, setInputError] = useState<string | undefined>();
  const suggestion = suggestTrackingCode(lookup);

  return (
    <div className="min-h-screen bg-background paper-grain">
      <PublicHeader width="2xl">
        <Link to="/report" className="inline-flex min-h-9 shrink-0 items-center text-sm text-muted-foreground hover:text-foreground">
          Submit a report
        </Link>
      </PublicHeader>

      <main className="mx-auto max-w-2xl px-4 py-12 md:px-8">
        <p className="kicker">Public tracking</p>
        <h1 className="display mt-2 text-3xl">Check report status</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Enter the tracking code you received when submitting a report.
        </p>

        <form
          className="paper mt-6 flex items-start gap-3 p-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const problem = trackingCodeProblem(input);
            setInputError(problem);
            if (problem) {
              focusField("code");
              return;
            }
            setSearchParams({ code: normalizeTrackingCode(input) });
          }}
        >
          <FormField label="Tracking code" id="code" error={inputError} className="flex-1 space-y-1.5">
            {(a11y) => (
              <Input
                {...a11y}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (inputError) setInputError(trackingCodeProblem(e.target.value));
                }}
                placeholder="CR-XXXXXXXXXXXXXXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono uppercase"
              />
            )}
          </FormField>
          <Button type="submit">
            <Search className="size-4" /> Look up
          </Button>
        </form>

        {code && (
          <div className="paper mt-6 p-6">
            {report === undefined ? (
              <PageLoading shape="form" label="your report" rows={2} compact />
            ) : report === null ? (
              <NoResults
                query={lookup}
                suggestion={suggestion}
                onUseSuggestion={(c) => {
                  setInput(c);
                  setSearchParams({ code: c });
                }}
                hint="Check each character — O (the letter) and 0 (zero), I and 1 look alike. If you were sent the code in a message, copy and paste it instead of typing it."
                onClear={() => {
                  setInput("");
                  setSearchParams({});
                }}
                className="border-0 p-0"
              />
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
                  Submitted {new Date(Number(report.createdAt)).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
