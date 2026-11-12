// ---------------------------------------------------------------------------
// COMPANY TEAM (Phase C) — a company administrator manages their own
// company's workforce: join requests, invitations, roles, suspension, removal and
// blocking (migration 0054).
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import type { CompanyBlock, CompanyInvitation, WorkforceMember } from "@/lib/types";
import {
  Ban, Loader2, MailPlus, MoreHorizontal, Pause, RotateCw, Search, ShieldAlert, ShieldOff, Undo2, UserCheck, UserX, XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageLoading } from "@/components/PageLoading";
import { FormField } from "@/components/FormField";
import { errorSentence } from "@/lib/error-messages";
import { toastSuccess } from "@/lib/feedback";
import { validateInvite } from "@/lib/form-rules";
import { emailProblem, focusField } from "@/lib/validation";

const ASSIGNABLE = ["worker", "supervisor", "safety_officer", "site_manager", "onboarding_officer"] as const;
/** Join requests are approved into an operational role only (the server enforces this too). */
const REQUEST_ROLES = ["worker", "safety_officer", "site_manager"] as const;
const ROLE_LABEL: Record<string, string> = {
  company_admin: "Company administrator",
  site_manager: "Site manager",
  safety_officer: "Safety officer",
  supervisor: "Supervisor",
  worker: "Worker",
  onboarding_officer: "Onboarding officer",
};

function errMsg(e: unknown): string {
  return errorSentence(e, { action: "complete that" });
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

type MemberAction = "suspend" | "remove" | "block";

const ACTION_COPY: Record<MemberAction, {
  title: string; confirm: string; required: boolean; destructive: boolean; hint: (co: string) => string; done: string; reassure: string;
}> = {
  suspend: {
    title: "Suspend", confirm: "Suspend", required: true, destructive: false, done: "Member suspended.",
    hint: (co) => `They lose access to ${co} immediately. Their membership and site assignments are kept, and you can reinstate them at any time.`,
    reassure: "They have been told their access is suspended. Reinstate them from the Members list.",
  },
  remove: {
    title: "Remove", confirm: "Remove", required: false, destructive: true, done: "Member removed.",
    hint: (co) => `They lose all access to ${co} immediately and are unassigned from every site. Their past reports and the audit trail stay in place. They can be invited again later.`,
    reassure: "Their past reports and the audit trail stay in place.",
  },
  block: {
    title: "Block", confirm: "Block", required: true, destructive: true, done: "Person blocked.",
    hint: (co) => `They are removed from ${co} immediately and cannot request to join, be invited or be reinstated until you unblock them. Any pending invitation to them is cancelled.`,
    reassure: "You can lift the block from the Blocked people list.",
  },
};

const REASON_MIN = 5;
const REASON_MAX = 500;

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
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
  const isAdminActive = Boolean(orgId && me?.orgRole === "company_admin" && me.memberStatus === "active");
  const team = useQuery(api.workforce.team, isAdminActive && orgId ? { organizationId: orgId } : "skip");
  const blocksQ = useQuery(api.workforce.blocks, isAdminActive && orgId ? { organizationId: orgId } : "skip");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [role, setRole] = useState("worker");
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<{ member: WorkforceMember; action: MemberAction } | null>(null);
  const [reason, setReason] = useState("");
  const [unblocking, setUnblocking] = useState<CompanyBlock | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended">("all");

  const allMembers = team ?? data?.members;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (allMembers ?? [])
      .filter((m) => m.status === "active" || m.status === "suspended")
      .filter((m) => statusFilter === "all" || m.status === statusFilter)
      .filter((m) => roleFilter === "all" || m.orgRole === roleFilter)
      .filter((m) => !q || (m.name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q));
  }, [allMembers, search, roleFilter, statusFilter]);

  if (me === undefined) return <div className="p-4 md:p-6"><PageLoading shape="list" label="team" /></div>;
  if (!me || me.orgRole !== "company_admin" || me.memberStatus !== "active") {
    return (
      <div className="p-4 md:p-6">
        <div className="paper flex min-w-0 items-start gap-3 p-6">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <div className="min-w-0">
            <p className="text-sm font-medium">Company administrator access required</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Managing a company's workforce is limited to its company administrators.
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (me.companyStatus !== "approved") {
    return (
      <div className="p-4 md:p-6">
        <div className="paper p-6 text-sm">
          <p className="font-medium">{me.organizationName} is not currently approved.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Workforce administration is paused until the Ministry restores the company. Nothing has been deleted.
          </p>
        </div>
      </div>
    );
  }

  const orgIdStrict = me.organizationId;
  const members = allMembers ?? [];
  const requests = members.filter((m) => m.status === "pending");
  const active = members.filter((m) => m.status === "active");
  const suspended = members.filter((m) => m.status === "suspended");
  const blocks = blocksQ ?? [];
  const invitations = (data?.invitations ?? []).filter((i) => i.status === "pending" || i.status === "expired").slice(0, 20);
  const counts = ASSIGNABLE.map((r) => ({ r, n: active.filter((m) => m.orgRole === r).length }));

  async function run(fn: () => Promise<unknown>, ok: string, reassure?: string): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      toastSuccess({ title: ok, reassure });
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openAction(member: WorkforceMember, action: MemberAction) {
    setReason("");
    setActing({ member, action });
  }

  const reasonText = reason.trim();
  const reasonProblem = acting && ACTION_COPY[acting.action].required && reasonText.length < REASON_MIN
    ? `Record a reason of at least ${REASON_MIN} characters.` : undefined;

  async function confirmAction() {
    if (!acting || reasonProblem) return;
    const { member, action } = acting;
    const copy = ACTION_COPY[action];
    const id = member.memberId;
    const ok = await run(() => {
      if (action === "suspend") return api.workforce.suspendMember({ memberId: id, reason: reasonText });
      if (action === "block") return api.workforce.blockMember({ memberId: id, reason: reasonText });
      return api.workforce.removeMember({ memberId: id, reason: reasonText || undefined });
    }, copy.done, copy.reassure);
    if (ok) setActing(null);
  }

  async function sendInvite() {
    const address = email.trim();
    const problem = validateInvite({ email: address }).email;
    setEmailError(problem);
    if (problem) {
      focusField("team-email");
      return;
    }
    await run(async () => {
      await api.workforce.invite({ organizationId: orgIdStrict, email: address, role });
      setEmail("");
    }, `Invitation sent to ${address.toLowerCase()}.`, "They'll join only after they accept the email link, which is valid for 7 days. You can revoke it below.");
  }

  return (
    <div className="min-w-0 space-y-8 p-4 md:p-6">
      <header className="min-w-0">
        <p className="kicker">{me.organizationName}</p>
        <h1 className="display mt-1 text-2xl break-words sm:text-3xl">Team</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Invite workers, decide join requests, assign roles, and suspend, remove or block people. You manage only {me.organizationName};
          the Ministry appoints company administrators.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {active.length} active member{active.length === 1 ? "" : "s"}
          {counts.map((c) => ` · ${c.n} ${ROLE_LABEL[c.r].toLowerCase()}${c.n === 1 ? "" : "s"}`).join("")}
          {suspended.length ? ` · ${suspended.length} suspended` : ""}
          {blocks.length ? ` · ${blocks.length} blocked` : ""}
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
            <FormField label="Email address" id="team-email" error={emailError} className="min-w-0 flex-1 space-y-1">
              {(a11y) => (
                <Input {...a11y} type="email" inputMode="email" autoComplete="off" placeholder="worker@company.com"
                  value={email} disabled={busy}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(emailProblem(e.target.value));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") void sendInvite(); }} />
              )}
            </FormField>
            <div className="space-y-1">
              <Label>Role</Label>
              <RoleSelect value={role} onChange={setRole} disabled={busy} label="Role for the invitation" />
            </div>
            <Button disabled={busy} onClick={() => void sendInvite()}>
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
        <CardHeader><CardTitle className="text-base">Members ({active.length + suspended.length})</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input className="pl-8" placeholder="Search by name or email" aria-label="Search members"
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-full sm:w-44" aria-label="Filter by role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {[...ASSIGNABLE, "company_admin"].map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
              <SelectTrigger className="w-full sm:w-36" aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {allMembers === undefined ? (
            <PageLoading shape="list" label="team" rows={3} compact />
          ) : filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {active.length + suspended.length === 0 ? "No members yet." : "No members match these filters."}
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((m) => {
                const isAdmin = m.orgRole === "company_admin";
                const isSuspended = m.status === "suspended";
                const who = m.email ?? m.name ?? "member";
                return (
                  <li key={m.memberId} className={`min-w-0 rounded-md border p-3 ${isSuspended ? "bg-muted/40" : ""}`}>
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium break-words">
                          {m.name ?? "Unnamed"}
                          {isSuspended && <Badge variant="outline">Suspended</Badge>}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {isAdmin ? (
                          <Badge variant="secondary">{ROLE_LABEL.company_admin}</Badge>
                        ) : (
                          <>
                            {isSuspended ? (
                              <Badge variant="secondary">{ROLE_LABEL[m.orgRole] ?? m.orgRole}</Badge>
                            ) : (
                              <RoleSelect value={m.orgRole} disabled={busy} label={`Role for ${who}`}
                                onChange={(r) => void run(() => api.workforce.setRole({ memberId: m.memberId, role: r }), "Role updated.")} />
                            )}
                            {isSuspended && (
                              <Button size="sm" variant="outline" disabled={busy} aria-label={`Reinstate ${who}`}
                                onClick={() => void run(() => api.workforce.reinstateMember({ memberId: m.memberId }), "Member reinstated.", "Their access is restored.")}>
                                <Undo2 className="size-3.5" /> Reinstate
                              </Button>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={`More actions for ${who}`}>
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {!isSuspended && (
                                  <DropdownMenuItem onSelect={() => openAction(m, "suspend")}>
                                    <Pause className="size-4" /> Suspend access
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onSelect={() => openAction(m, "remove")}>
                                  <UserX className="size-4" /> Remove from company
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onSelect={() => openAction(m, "block")}>
                                  <Ban className="size-4" /> Remove and block
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </>
                        )}
                      </div>
                    </div>
                    {isSuspended && (
                      <p className="mt-2 break-words text-xs text-muted-foreground">
                        Suspended{m.statusChangedAt ? ` on ${when(m.statusChangedAt)}` : ""}
                        {m.statusChangedByName ? ` by ${m.statusChangedByName}` : ""}
                        {m.statusReason ? ` — ${m.statusReason}` : ""}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {blocks.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Blocked people ({blocks.length})</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Blocked people cannot request to join, accept an invitation or be reinstated. Unblocking does not give
              access back: they would need to be invited or approved again.
            </p>
            <ul className="space-y-2">
              {blocks.map((b) => (
                <li key={b.blockId} className="flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{b.name ?? "Unnamed"}</p>
                    <p className="break-all text-xs text-muted-foreground">{b.email}</p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      Blocked {when(b.blockedAt)}{b.blockedByName ? ` by ${b.blockedByName}` : ""} — {b.reason}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setUnblocking(b)}
                    aria-label={`Unblock ${b.email}`}><ShieldOff className="size-3.5" /> Unblock</Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={acting !== null} onOpenChange={(o) => { if (!o && !busy) setActing(null); }}>
        <DialogContent>
          {acting && (() => {
            const copy = ACTION_COPY[acting.action];
            const name = acting.member.name ?? acting.member.email ?? "this person";
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{copy.title} {name}?</DialogTitle>
                  <DialogDescription>{copy.hint(me.organizationName)}</DialogDescription>
                </DialogHeader>
                <FormField label={copy.required ? "Reason (required)" : "Reason (optional)"} id="team-action-reason"
                  error={reasonText.length > 0 || !copy.required ? reasonProblem : undefined} className="space-y-1">
                  {(a11y) => (
                    <Textarea {...a11y} rows={3} maxLength={REASON_MAX} value={reason} disabled={busy}
                      placeholder="What happened? Only company administrators can read this."
                      onChange={(e) => setReason(e.target.value)} />
                  )}
                </FormField>
                <p className="text-xs text-muted-foreground">
                  The person is told that their access changed, not the reason. Every action is recorded in the audit trail.
                </p>
                <DialogFooter>
                  <Button variant="outline" disabled={busy} onClick={() => setActing(null)}>Cancel</Button>
                  <Button variant={copy.destructive ? "destructive" : "default"} disabled={busy || Boolean(reasonProblem)}
                    onClick={() => void confirmAction()}>
                    {busy && <Loader2 className="size-4 animate-spin" />} {copy.confirm}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <AlertDialog open={unblocking !== null} onOpenChange={(o) => { if (!o) setUnblocking(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unblock {unblocking?.name ?? unblocking?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will be able to request to join {me.organizationName} or be invited again. Nothing is restored automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const target = unblocking!;
              void run(() => api.workforce.unblock({ blockId: target.blockId }), "Person unblocked.");
            }}>Unblock</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
