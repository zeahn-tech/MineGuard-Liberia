import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { CONFIRM_WORD, confirmationMatches, type EmergencyAction } from "@/lib/emergency";

/** High-impact emergency actions need a deliberate, typed confirmation. The SERVER checks the
 *  same word, so this dialog is a guard against accidents, not a security control. */
type Props = {
  open: boolean;
  action: EmergencyAction;
  title: string;
  description: ReactNode;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
};

export function ConfirmWordDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={(o) => (!o && !props.busy ? props.onCancel() : undefined)}>
      <DialogContent>{props.open && <ConfirmBody {...props} />}</DialogContent>
    </Dialog>
  );
}

// Mounted only while open, so the typed word always starts empty.
function ConfirmBody(props: Props) {
  const [typed, setTyped] = useState("");
  const ok = confirmationMatches(props.action, typed);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription asChild>
          <div className="text-sm text-muted-foreground">{props.description}</div>
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="mg-confirm-word">
          Type <span className="font-mono font-semibold">{CONFIRM_WORD[props.action]}</span> to confirm
        </Label>
        <Input
          id="mg-confirm-word"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        {props.error && (
          <p role="alert" className="text-sm text-destructive">
            {props.error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel} disabled={props.busy}>
          Back
        </Button>
        <Button
          variant={props.action === "activate" || props.action === "update" ? "default" : "destructive"}
          disabled={!ok || props.busy}
          onClick={() => props.onConfirm(typed.trim())}
        >
          {props.busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          Confirm {props.action}
        </Button>
      </DialogFooter>
    </>
  );
}
