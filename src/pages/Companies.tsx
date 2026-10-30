// ---------------------------------------------------------------------------
// MINISTRY — COMPANIES (Phase B). Register/authorize a company, nominate its
// initial administrator by Supabase email invitation, and manage its status.
// Admin-only in the UI AND in the database: every action below is a server-side
// RPC / edge function that requires organizations.write — hiding this page is
// a convenience, not the boundary.
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
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import { useMutation, useQuery } from "@/lib/backend-react";
import type { Company, CompanyInvitation, CompanyStatus } from "@/lib/types";
import { Building2, Loader2, MailPlus, RotateCw, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

const STATUS_LABEL: Record<CompanyStatus, string> = {
  pending_review: "Pending review",
  approved: "Approved",
  suspended: "Suspended",
  deactivated: "Deactivated",
};

function errMsg(e: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline — reconnect and try again.";
  }
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

function invitationState(i: CompanyInvitation): { label: string; live: boolean } {
  if (i.status === "pending" && i.expiresAt <= Date.now()) return { label: "Expired", live: false };
  if (i.status === "pending") return { label: "Pending", live: true };
  return { label: i.status[0].toUpperCase() + i.status.slice(1), live: false };
}

function InvitationRow({ inv, busy, onResend, onRevoke }: {
  inv: CompanyInvitation;
  busy: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const st = invitationState(inv);
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium">{inv.email}</p>
        <p className="text-xs text-muted-foreground">
          Company administrator · {st.live ? `expires ${new Date(inv.expiresAt).toLocaleDateString()}` : st.label.toLowerCase()}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={st.live ? "secondary" : "outline"}>{st.label}</Badge>
        {st.live && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={onResend} aria-label={`Resend invitation to ${inv.email}`}>
              <RotateCw className="size-3.5" /> Resend
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRevoke} aria-label={`Revoke invitation to ${inv.email}`}>
              <XCircle className="size-3.5" /> Revoke
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function CompanyCard({ company, detailTo }: { company: Company; detailTo?: string }) {
  const invite = useMutation(api.companies.inviteAdmin);
  const resend = useMutation(api.companies.resendInvitation);
  const revoke = useMutation(api.companies.revokeInvitation);
  const setStatus = useMutation(api.companies.setStatus);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "suspended" | "deactivated">(null);
  const [reason, setReason] = useState("");

  const admins = company.members.filter((m) => m.orgRole === "company_admin" && m.status === "active");
  const approved = company.status === "approved";
  const activeCount = company.activeMembers;
  const pendingCount = company.pendingRequests;

  async function run<T>(fn: () => Promise<T>, ok: string) {
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
      const r = (await invite({ organizationId: company.id, email: address })) as { delivery: string };
      setEmail("");
      return r;
    }, `Invitation sent to ${email.trim().toLowerCase()}.`);
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base break-words">
            <Building2 className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            {company.name}
          </CardTitle>
          <Badge variant={approved ? "secondary" : "destructive"}>{STATUS_LABEL[company.status]}</Badge>
        </div>
        {detailTo && (
          <Link to={detailTo} className="w-fit text-xs underline underline-offset-2">
            View sites and details
          </Link>
        )}
        <p className="text-xs text-muted-foreground">
          {company.siteCount} registered site{company.siteCount === 1 ? "" : "s"}
          {` · ${activeCount} active member${activeCount === 1 ? "" : "s"}`}
          {pendingCount > 0 ? ` · ${pendingCount} awaiting approval` : ""}
          {company.statusReason ? ` · ${company.statusReason}` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <section aria-label="Company administrators" className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Administrators</h3>
          {admins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No administrator has accepted yet.</p>
          ) : (
            <ul className="space-y-1">
              {admins.map((a) => (
                <li key={a.userId} className="break-all text-sm">
                  {a.name ? `${a.name} · ` : ""}{a.email ?? a.userId}
                </li>
              ))}
            </ul>
          )}
        </section>

        {company.invitations.length > 0 && (
          <section aria-label="Invitations" className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invitations</h3>
            <ul className="space-y-2">
              {company.invitations.slice(0, 5).map((inv) => (
                <InvitationRow
                  key={inv.id}
                  inv={inv}
                  busy={busy}
                  onResend={() => void run(() => resend({ invitationId: inv.id }), "Invitation resent.")}
                  onRevoke={() => void run(() => revoke({ invitationId: inv.id }), "Invitation revoked.")}
                />
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Nominate an administrator" className="space-y-2">
          <Label htmlFor={`inv-${company.id}`}>Nominate a company administrator</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`inv-${company.id}`}
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder="representative@company.com"
              value={email}
              disabled={!approved || busy}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendInvite(); }}
            />
            <Button disabled={!approved || busy || !email.trim()} onClick={() => void sendInvite()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <MailPlus className="size-4" />} Send invitation
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {approved
              ? "They receive a one-time email link, sign in with that address, and accept. Nothing is granted until they accept. The invitation expires in 7 days."
              : "Only an approved company can receive an administrator."}
          </p>
        </section>

        <section aria-label="Company status" className="flex flex-wrap gap-2 border-t pt-4">
          {approved ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { setReason(""); setConfirm("suspended"); }}>Suspend access</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setReason(""); setConfirm("deactivated"); }}>Deactivate</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => setStatus({ organizationId: company.id, status: "approved" }), "Company reactivated.")}>
              {company.status === "pending_review" ? "Approve company" : "Reactivate company"}
            </Button>
          )}
        </section>
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "deactivated" ? "Deactivate" : "Suspend"} {company.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Company users immediately lose access to sites, incidents, inspections and corrective actions.
              Nothing is deleted, the Ministry keeps full oversight, and access returns if you reactivate the company.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`reason-${company.id}`}>Reason (recorded in the audit trail)</Label>
            <Input id={`reason-${company.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reason.trim().length < 5}
              onClick={() => {
                const status = confirm!;
                void run(() => setStatus({ organizationId: company.id, status, reason: reason.trim() }),
                  status === "deactivated" ? "Company deactivated." : "Company suspended.");
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function Companies() {
  const { user } = useAuth();
  const companies = useQuery(api.companies.list);
  const register = useMutation(api.companies.register);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (!user) return null;
  if (user.role !== "admin" && user.role !== "registrar") {
    return (
      <div className="paper flex min-w-0 items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="min-w-0">
          <p className="text-sm font-medium">Ministry authorization access required</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Registering companies and nominating their administrators is limited to Ministry administrators and company registrars.
          </p>
        </div>
      </div>
    );
  }

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await register({ name });
      toast.success(`${name.trim()} registered and approved.`);
      setName("");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-8">
      <header className="min-w-0">
        <p className="kicker">Administration</p>
        <h1 className="display mt-1 text-2xl break-words sm:text-3xl">Companies</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Authorize a mining company, then nominate its administrator. The administrator accepts by email and
          then manages the company's own workforce; the Ministry keeps regulatory oversight.
        </p>
      </header>

      <Card>
        <CardHeader><CardTitle className="text-base">Register a company</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="company-name">Company name</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="company-name" value={name} maxLength={200} placeholder="e.g. ArcelorMittal Liberia"
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
            <Button disabled={busy || name.trim().length < 2} onClick={() => void add()}>
              {busy && <Loader2 className="size-4 animate-spin" />} Register and approve
            </Button>
          </div>
        </CardContent>
      </Card>

      {companies === undefined ? (
        <p className="text-sm text-muted-foreground" role="status">Loading companies…</p>
      ) : companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No companies registered yet.</p>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {companies.map((c) => (
            <CompanyCard key={c.id} company={c} detailTo={user.role === "admin" ? `/portal/companies/${c.id}` : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
