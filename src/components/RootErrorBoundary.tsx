import React from "react";
import { Button } from "@/components/ui/button";

interface State {
  hasError: boolean;
  message: string;
  stack: string;
}

/**
 * Last-resort boundary: replaces a blank page with a recoverable screen.
 *
 * Users get a generic message and a reload action; the error itself is
 * logged to the console for diagnostics. The message and stack trace are
 * rendered only in development builds — they can expose internals (file
 * paths, query shapes) and mean nothing to field staff.
 */
export class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, message: "", stack: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[RootErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        className="min-h-screen flex items-center justify-center bg-background text-foreground p-6"
      >
        <div className="max-w-lg text-center">
          <p className="text-sm font-semibold">Something went wrong</p>
          <p className="mt-2 text-xs text-muted-foreground">
            The app hit an unexpected error. Your queued offline work is safe on
            this device. Reload to continue; if it keeps happening, contact your
            administrator.
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
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
