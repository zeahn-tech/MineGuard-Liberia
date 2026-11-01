// ---------------------------------------------------------------------------
// FEEDBACK — the two toasts every flow needs, written to a standard.
//
// toastError   what went wrong · whose side · how to fix  (via describeError)
// toastSuccess confirm what happened · reassure · say what happens next
//
// Components call these instead of toast.error(e.message) / toast.success("Done"),
// so the wording and the pattern stay consistent across the app.
// ---------------------------------------------------------------------------

import { toast } from "sonner";
import { describeError, type DescribeOptions } from "@/lib/error-messages";

export function toastError(err: unknown, opts: DescribeOptions & { action?: string } = {}): void {
  const d = describeError(err, opts);
  const ref = d.reference && d.cause === "service" ? ` Reference: ${d.reference}.` : "";
  toast.error(d.what, {
    description: `${d.whose} ${d.fix}${ref}`,
    duration: 9000,
  });
}

export interface NextStep {
  label: string;
  /** Router path (the app uses hash routing). */
  to?: string;
  onClick?: () => void;
}

export function toastSuccess(input: {
  /** What just happened, past tense: "Incident reported." */
  title: string;
  /** Why they can relax / what was kept: "It's saved and the site team has been notified." */
  reassure?: string;
  /** The one useful next thing. */
  next?: NextStep;
}): void {
  const { title, reassure, next } = input;
  toast.success(title, {
    description: reassure,
    duration: next ? 8000 : 5000,
    action: next
      ? {
          label: next.label,
          onClick: () => {
            if (next.onClick) next.onClick();
            else if (next.to) window.location.hash = `#${next.to}`;
          },
        }
      : undefined,
  });
}
