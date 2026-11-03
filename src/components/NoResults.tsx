import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Nothing matched" for a search or filter: names what was searched, offers the
 * corrected spelling when we have one that really exists in the data, and always
 * leaves a way out (clear the search). Never a dead end.
 */
export function NoResults({
  query,
  suggestion,
  onUseSuggestion,
  onClear,
  hint,
  className = "",
}: {
  query: string;
  /** A corrected query that is known to match something. */
  suggestion?: string | null;
  onUseSuggestion?: (suggestion: string) => void;
  onClear?: () => void;
  /** Extra guidance when there is no suggestion. */
  hint?: string;
  className?: string;
}) {
  return (
    <div role="status" className={`flex min-w-0 items-start gap-3 rounded-sm border border-border p-4 text-sm ${className}`}>
      <SearchX className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <p className="font-medium break-words">No results for “{query}”.</p>
        {suggestion ? (
          <p className="text-muted-foreground">
            Did you mean{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => onUseSuggestion?.(suggestion)}
            >
              {suggestion}
            </button>
            ?
          </p>
        ) : (
          <p className="text-muted-foreground">{hint ?? "Check the spelling, or try fewer or different words."}</p>
        )}
        {onClear && (
          <Button size="sm" variant="outline" onClick={onClear}>
            Clear search
          </Button>
        )}
      </div>
    </div>
  );
}
