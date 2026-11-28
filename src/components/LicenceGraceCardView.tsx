// ---------------------------------------------------------------------------
// MINISTRY — LICENCE GRACE PERIOD CARD, presentational part (migration 0067; the container is LicenceGraceCard.tsx).
// One platform-wide date: until then, companies WITHOUT a licence number may still request new sites. Shown only to Ministry
// users who hold platform_settings.write (administrator, registrar). This hiding is cosmetic: mg_set_licence_grace_until and
// mg_licence_grace_status enforce the permission in the database.
// ---------------------------------------------------------------------------
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/FormField";
import type { GraceStatusResult } from "@/lib/backend";
import { toastSuccess } from "@/lib/feedback";
import { addDays, format, startOfToday } from "date-fns";
import {
  GRACE_MAX_DAYS,
  GRACE_MAX_REASON as GRACE_REASON_MAX,
  GRACE_OFF_CONFIRM_TEXT,
  formatGraceDate,
  graceConfirmText,
  graceReasonProblem,
} from "@/lib/licence-grace";
import { CalendarDays, Loader2 } from "lucide-react";
import { useState } from "react";

export function LicenceGraceCardView({
  result,
  setGrace,
}: {
  /** undefined = still loading */
  result: GraceStatusResult | undefined;
  setGrace: (args: { until: string | null; reason: string }) => Promise<unknown>;
}) {
  const [date, setDate] = useState<Date | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<{ date?: string; reason?: string }>({});
  const [confirm, setConfirm] = useState<"save" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  if (result === undefined) {
    return (
      <Card aria-busy="true">
        <CardHeader><CardTitle className="text-base">Licence grace period</CardTitle></CardHeader>
        <CardContent className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-9 w-full" /></CardContent>
      </Card>
    );
  }
  if (result.state === "forbidden") return null; // not a holder of platform_settings.write: no card at all
  if (result.state === "error") {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Licence grace period</CardTitle></CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-muted-foreground">The grace period could not be loaded. Check your connection and refresh the page.</p>
        </CardContent>
      </Card>
    );
  }

  const status = result.status;
  const today = startOfToday();
  const iso = date ? format(date, "yyyy-MM-dd") : null;

  function validate(kind: "save" | "off"): boolean {
    const next: { date?: string; reason?: string } = {};
    if (kind === "save" && !date) next.date = "Choose the last day companies without a licence number may request sites.";
    const r = graceReasonProblem(reason);
    if (r) next.reason = r;
    setFieldError(next);
    return Object.keys(next).length === 0;
  }

  async function run(kind: "save" | "off") {
    setBusy(true);
    setSaveError(undefined);
    try {
      await setGrace({ until: kind === "off" ? null : iso, reason });
      toastSuccess({
        title: kind === "off" ? "Grace period switched off." : `Grace period set to ${formatGraceDate(iso as string)}.`,
        reassure: "The change is in the audit log and the other administrators have been told.",
      });
      setConfirm(null);
      setReason("");
      setDate(undefined);
    } catch (e) {
      setConfirm(null);
      setSaveError(e instanceof Error ? e.message : "The change could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Licence grace period</CardTitle></CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Last day</dt><dd className="font-medium" data-testid="grace-until">{status.until ? formatGraceDate(status.until) : "Off"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Status</dt><dd className="font-medium">{status.isActive ? "Active" : "Not active"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Days left</dt><dd className="font-medium">{status.daysLeft === null ? "—" : status.daysLeft}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Companies without a licence number</dt><dd className="font-medium">{status.companiesWithoutLicence}</dd></div>
        </dl>
        <p className="text-xs leading-relaxed text-muted-foreground">
          One date for the whole platform. Until it passes, companies without a licence number may still request new sites. Existing sites and
          companies with a licence number are not affected.
        </p>

        <FormField label="New last day" id="grace-date" error={fieldError.date} className="space-y-2">
          {(a11y) => (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button {...a11y} type="button" variant="outline" className="w-full justify-start sm:w-64">
                  <CalendarDays className="size-4" /> {date ? format(date, "d MMMM yyyy") : "Choose a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={(d) => { setDate(d); setPickerOpen(false); setFieldError((e) => ({ ...e, date: undefined })); }}
                  disabled={{ before: today, after: addDays(today, GRACE_MAX_DAYS) }}
                  defaultMonth={date ?? today}
                />
              </PopoverContent>
            </Popover>
          )}
        </FormField>

        <FormField label="Reason (recorded in the audit log)" id="grace-reason" error={fieldError.reason} className="space-y-2">
          {(a11y) => (
            <Input {...a11y} value={reason} maxLength={GRACE_REASON_MAX} placeholder="e.g. Ministry extended the deadline for the 2027 licensing round"
              onChange={(e) => { setReason(e.target.value); if (fieldError.reason) setFieldError((x) => ({ ...x, reason: graceReasonProblem(e.target.value) })); }} />
          )}
        </FormField>

        {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button disabled={busy} onClick={() => { if (validate("save")) setConfirm("save"); }}>
            {busy && confirm === "save" && <Loader2 className="size-4 animate-spin" />} Save grace date
          </Button>
          <Button variant="outline" disabled={busy || status.until === null} onClick={() => { if (validate("off")) setConfirm("off"); }}>
            Switch off grace period
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o && !busy) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "off" ? "Switch off the grace period?" : "Save the grace date?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "off" ? GRACE_OFF_CONFIRM_TEXT : iso ? graceConfirmText(iso) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); if (confirm) void run(confirm); }}>
              {busy && <Loader2 className="size-4 animate-spin" />} {confirm === "off" ? "Switch off" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
