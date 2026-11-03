import React from "react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/error-messages";

interface State {
  hasError: boolean;
  message: string;
  stack: string;
  /** "network": a part of the app could not be downloaded; "crash": a bug. */
  kind: "network" | "crash";
  /** Short, non-identifying code a person can read out to support. */
  reference: string;
}

/** 6 hex chars from the error text: stable for the same fault, reveals nothing. */
function referenceOf(error: Error): string {
  const text = `${error.name}:${error.message}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6).toUpperCase();
}

/**
 * Last-resort boundary: replaces a blank page with a recoverable screen that
 * says what happened, whose side it is on, and how to carry on.
 *
 *  - A failed download of part of the app (poor connection) is the connection's
 *    fault and is described that way.
 *  - Anything else is a bug on our side and is described that way — never as
 *    something the person did.
 *
 * The error itself is logged for diagnostics. The message and stack trace are
 * rendered only in development builds — they can expose internals (file paths,
 * query shapes) and mean nothing to field staff. People get a short reference
 * code instead, to quote to an administrator.
 */
export class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, message: "", stack: "", kind: "crash", reference: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
      kind: describeError(error).cause === "network" ? "network" : "crash",
      reference: referenceOf(error),
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[RootErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const network = this.state.kind === "network";
    return (
      <div
        role="alert"
        className="min-h-screen flex items-center justify-center bg-background text-foreground p-6"
      >
        <div className="max-w-lg text-center">
          <p className="text-sm font-semibold">
            {network ? "Part of the app couldn't be downloaded." : "The app ran into an unexpected problem."}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {network
              ? "This is your connection, not something you did."
              : "This is on us, not something you did."}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {network
              ? "Check that you're online, then reload."
              : "Reload to carry on. If it keeps happening, tell your administrator and quote the reference below."}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Work you saved or queued, and report forms you were filling in, are kept on this device.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                window.location.hash = "#/";
                window.location.reload();
              }}
            >
              Go to the start page
            </Button>
          </div>
          {!network && (
            <p className="mt-3 text-[11px] text-muted-foreground">Reference: {this.state.reference}</p>
          )}
          {import.meta.env.DEV && (
            <>
              <p className="mt-4 text-xs text-muted-foreground break-words">
                {this.state.message}
              </p>
              {this.state.stack && (
                <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                  {this.state.stack}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
}
