import { useId, type ReactNode } from "react";
import { FieldError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";

/** Props every control inside a FormField must receive. */
export interface FieldControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  "aria-describedby"?: string;
}

/** Add to native <select>/<textarea> classes so an invalid field is outlined. */
export const invalidControlClass =
  "aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30";

/**
 * A labelled field that flags ITSELF: the error appears directly under the
 * control it belongs to, is announced to screen readers, and says how to fix it.
 * The control is rendered by the caller (input, select, textarea…) and receives
 * the id / aria wiring through the render prop.
 */
export function FormField({
  label,
  required,
  error,
  hint,
  id: idProp,
  className = "",
  children,
}: {
  label: ReactNode;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  /** Provide when the id must be known outside (to move focus after a failed submit). */
  id?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const auto = useId();
  const id = idProp ?? `f${auto.replace(/:/g, "")}`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  const control: FieldControlProps = { id };
  if (error) control["aria-invalid"] = true;
  if (required) control["aria-required"] = true;
  if (describedBy) control["aria-describedby"] = describedBy;

  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-destructive">
            {" "}
            *
          </span>
        )}
      </Label>
      {children(control)}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
