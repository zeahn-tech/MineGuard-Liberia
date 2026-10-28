// ---------------------------------------------------------------------------
// COMPANY TEAM (Phase C) — a company administrator manages their own
// company's workforce: join requests, invitations, roles, removal.
// The page is a convenience: every action is a server-side function that
// re-checks "active administrator of this approved company" (or the Ministry).
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import type { CompanyInvitation, WorkforceMember } from "@/lib/types";
import { Loader2, MailPlus, RotateCw, ShieldAlert, UserCheck, UserX, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const ASSIGNABLE = ["worker", "safety_officer", "site_manager", "onboarding_officer"] as const;
/** Join requests are approved into an operational role only (the server enforces this too). */
const REQUEST_ROLES = ["worker", "safety_officer", "site_manager"] as const;
const ROLE_LABEL: Record<string, string> = {
  company_admin: "Company administrator",
  site_manager: "Site manager",
  safety_officer: "Safety officer",
  worker: "Worker",
  onboarding_officer: "Onboarding officer",
};

function errMsg(e: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline — reconnect and try again.";
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

function RoleSelect({ value, onChange, disabled, label, roles = ASSIGNABLE }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; label: string; roles?: readonly string[];
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full sm:w-44" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        {roles.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function RequestRow({ m, busy, onDecide }: {
  m: WorkforceMember; busy: boolean; onDecide: (approve: boolean, role: string) => void;
}) {
  const [role, setRole] = useState("worker");
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium break-words">{m.name ?? "Unnamed"}</p>
        <p className="break-all text-xs text-muted-foreground">{m.email}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RoleSelect roles={REQUEST_ROLES} value={role} onChange={setRole} disabled={busy} label={`Role for ${m.email ?? "applicant"}`} />
        <Button size="sm" disabled={busy} onClick={() => onDecide(true, role)}><UserCheck className="size-3.5" /> Approve</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(false, role)}><UserX className="size-3.5" /> Decline</Button>
      </div>
    </li>
  );
}

function invState(i: CompanyInvitation) {
  if (i.status === "pending" && i.expiresAt <= Date.now()) return { label: "Expired", live: false };
  if (i.status === "pending") return { label: "Pending", live: true };
  return { label: i.status[0].toUpperCase() + i.status.slice(1), live: false };
}

export default function OperatorTeam() {
  const me = useQuery(api.workforce.myMembership);
  const orgId = me?.organizationId;
  const data = useQuery(api.workforce.list, orgId && me?.orgRole === "company_admin" && me.memberStatus === "active" ? { organizationId: orgId } : "skip");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("worker");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<WorkforceMember | null>(null);

  if (me === undefined) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!me || me.orgRole !== "company_admin" || me.memberStatus !== "active") {
    return (
      <div className="paper flex min-w-0 items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="min-w-0">
          <p className="text-sm font-medium">Company administrator access required</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Managing a company's workforce is limited to its company administrators.
          </p>
        </div>
      </div>
    );
  }
  if (me.companyStatus !== "approved") {
    return (
      <div className="paper p-6 text-sm">
        <p className="font-medium">{me.organizationName} is not currently approved.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Workforce administration is paused until the Ministry restores the company. Nothing has been deleted.
        </p>
      </div>
    );
  }

  const orgIdStrict = me.organizationId;
  const members = data?.members ?? [];
  const requests = members.filter((m) => m.status === "pending");
  const active = members.filter((m) => m.status === "active");
  const invitations = (data?.invitations ?? []).filter((i) => i.status === "pending" || i.status === "expired").slice(0, 20);
  const counts = ASSIGNABLE.map((r) => ({ r, n: active.filter((m) => m.orgRole === r).length }));

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendInvite() {
    const address = email.trim();
    if (!address) return;
    await run(async () => {
      await api.workforce.invite({ organizationId: orgIdStrict, email: address, role });
      setEmail("");
    }, `Invitation sent to ${address.toLowerCase()}.`);
  }

  return (
    <div className="min-w-0 space-y-8">
      <header className="min-w-0">
        <p className="kicker">{me.organizationName}</p>
        <h1 className="display mt-1 text-2xl break-words sm:text-3xl">Team</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Invite workers, decide join requests and assign roles. You manage only {me.organizationName};
          the Ministry appoints company administrators.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {active.length} active member{active.length === 1 ? "" : "s"}
          {counts.map((c) => ` · ${c.n} ${ROLE_LABEL[c.r].toLowerCase()}${c.n === 1 ? "" : "s"}`).join("")}
          {requests.length ? ` · ${requests.length} awaiting approval` : ""}
        </p>
      </header>

      {requests.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Join requests ({requests.length})</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {requests.map((m) => (
                <RequestRow key={m.memberId} m={m} busy={busy}
                  onDecide={(approve, r) => void run(
                    () => api.workforce.decideRequest({ memberId: m.memberId, approve, role: r }),
                    approve ? "Request approved." : "Request declined.")} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Invite someone</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="team-email">Email address</Label>
              <Input id="team-email" type="email" inputMode="email" autoComplete="off" placeholder="worker@company.com"
                value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void sendInvite(); }} />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <RoleSelect value={role} onChange={setRole} disabled={busy} label="Role for the invitation" />
            </div>
            <Button disabled={busy || !email.trim()} onClick={() => void sendInvite()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <MailPlus className="size-4" />} Send
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            They get a one-time email link and join only after they accept. Invitations expire after 7 days.
          </p>
          {invitations.length > 0 && (
            <ul className="space-y-2 pt-2">
              {invitations.map((i) => {
                const st = invState(i);
                return (
                  <li key={i.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="break-all text-sm font-medium">{i.email}</p>
                      <p className="text-xs text-muted-foreground">{ROLE_LABEL[i.orgRole] ?? i.orgRole}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={st.live ? "secondary" : "outline"}>{st.label}</Badge>
                      {st.live && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy}
                            onClick={() => void run(() => api.workforce.resendInvitation({ invitationId: i.id }), "Invitation resent.")}
                            aria-label={`Resend invitation to ${i.email}`}><RotateCw className="size-3.5" /> Resend</Button>
                          <Button size="sm" variant="ghost" disabled={busy}
                            onClick={() => void run(() => api.workforce.revokeInvitation({ invitationId: i.id }), "Invitation revoked.")}
                            aria-label={`Revoke invitation to ${i.email}`}><XCircle className="size-3.5" /> Revoke</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Members</CardTitle></CardHeader>
        <CardContent>
          {data === undefined ? (
            <p className="text-sm text-muted-foreground" role="status">Loading team…</p>
          ) : (
            <ul className="space-y-2">
              {active.map((m) => {
                const isAdmin = m.orgRole === "company_admin";
                return (
                  <li key={m.memberId} className="flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium break-words">{m.name ?? "Unnamed"}</p>
                      <p className="break-all text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {isAdmin ? (
                        <Badge variant="secondary">{ROLE_LABEL.company_admin}</Badge>
                      ) : (
                        <>
                          <RoleSelect value={m.orgRole} disabled={busy} label={`Role for ${m.email ?? "member"}`}
                            onChange={(r) => void run(() => api.workforce.setRole({ memberId: m.memberId, role: r }), "Role updated.")} />
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(m)}
                            aria-label={`Remove ${m.email ?? "member"}`}><UserX className="size-3.5" /> Remove</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name ?? removing?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose all access to {me.organizationName} immediately. Their past reports and the audit trail stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const target = removing!;
              void run(() => api.workforce.revokeMember({ memberId: target.memberId }), "Member removed.");
            }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
