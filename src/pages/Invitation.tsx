// ---------------------------------------------------------------------------
// INVITATION LANDING (Phase B). The invitee arrives from the Supabase email
// link already signed in with the invited address. Nothing is granted until
// they press Accept; the server then re-checks the verified email, expiry,
// revocation, company status and one-company-per-user.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { api, completeInviteAccount, updatePassword } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { Building2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { PublicHeader } from "@/components/PublicHeader";
import { toast } from "sonner";

const ROLE_LABEL: Record<string, string> = {
  company_admin: "Company administrator",
  site_manager: "Site manager",
  safety_officer: "Safety officer",
  worker: "Worker",
  onboarding_officer: "Onboarding officer",
};

export default function Invitation() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const navigate = useNavigate();
  const invitations = useQuery(api.companies.myInvitations);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!isAuthenticated) return <Navigate to="/auth?returnTo=%2Finvitation" replace />;

  async function accept(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.companies.acceptInvitation({ invitationId: id });
      toast.success("Invitation accepted. Welcome aboard.");
      navigate("/operate", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept the invitation.");
    } finally {
      setBusyId(null);
    }
  }

  // An invited account arrives signed in but nameless and without a password: it
  // must be created (name + password) before the invitation can be accepted.
  const needsAccount = !user?.name;

  async function createAccount() {
    if (fullName.trim().length < 2) return setError("Enter your full name.");
    if (pw.length < 10) return setError("Use a password of at least 10 characters.");
    if (pw !== pw2) return setError("The two passwords do not match.");
    setPwBusy(true);
    setError(null);
    try {
      await completeInviteAccount({ name: fullName, password: pw });
      toast.success("Account created. You can now accept the invitation.");
      setPw("");
      setPw2("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the account.");
    } finally {
      setPwBusy(false);
    }
  }

  async function savePassword() {
    if (pw.length < 10) return setError("Use a password of at least 10 characters.");
    if (pw !== pw2) return setError("The two passwords do not match.");
    setPwBusy(true);
    setError(null);
    try {
      await updatePassword(pw);
      toast.success("Password saved. You can now sign in with your email and password.");
      setPw("");
      setPw2("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the password.");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PublicHeader width="lg" />
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 p-4 sm:p-8">
        <header>
          <h1 className="display text-2xl">Company invitation</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Signed in as <span className="break-all font-medium">{user?.email ?? "your account"}</span>.
          </p>
        </header>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {invitations === undefined ? (
          <p className="text-sm text-muted-foreground" role="status">Checking for invitations…</p>
        ) : invitations.length === 0 ? (
          <Card>
            <CardContent className="space-y-2 pt-6 text-sm">
              <p className="font-medium">No pending invitation for this account.</p>
              <p className="text-muted-foreground">
                Invitations are tied to the exact email address they were sent to, and expire after 7 days.
                If you expected one, sign out and use the link from your email again, or ask the Ministry to resend it.
              </p>
              <Button variant="outline" onClick={() => void signOut()}>Sign out</Button>
            </CardContent>
          </Card>
        ) : (
          invitations.map((inv) => (
            <Card key={inv.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base break-words">
                  <Building2 className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  {inv.organizationName}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">
                  You have been nominated as <strong>{ROLE_LABEL[inv.orgRole] ?? inv.orgRole}</strong>.
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  By accepting you become responsible for this company's workforce in MineGuard.
                  This is limited to {inv.organizationName}. Expires {new Date(inv.expiresAt).toLocaleDateString()}.
                </p>
                {needsAccount && (
                  <p className="text-xs text-destructive">Create your account below first.</p>
                )}
                <Button className="w-full" disabled={busyId !== null || needsAccount} onClick={() => void accept(inv.id)}>
                  {busyId === inv.id && <Loader2 className="size-4 animate-spin" />} Accept invitation
                </Button>
              </CardContent>
            </Card>
          ))
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{needsAccount ? "Create your account" : "Set a password"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {needsAccount
                ? "Your email link signed you in once. Add your name and a password so you can sign in again."
                : "Your email link signs you in once. Set a password so you can sign in again later."}
            </p>
            {needsAccount && (
              <div className="space-y-1">
                <Label htmlFor="inv-name">Full name</Label>
                <Input id="inv-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="inv-pw">New password</Label>
              <Input id="inv-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-pw2">Repeat password</Label>
              <Input id="inv-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
            <Button variant={needsAccount ? "default" : "outline"} disabled={pwBusy || !pw}
              onClick={() => void (needsAccount ? createAccount() : savePassword())}>
              {pwBusy && <Loader2 className="size-4 animate-spin" />} {needsAccount ? "Create account" : "Save password"}
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
