// ---------------------------------------------------------------------------
// SECURITY — account security settings (Gap Closure Directive Gap #4).
//
// TOTP multi-factor enrollment and management, plus the authenticated
// password change. The GoTrue wire contract lives in src/lib/supabase.ts
// (mfaAal / mfaEnrollStart / mfaEnrollVerify / mfaListFactors / mfaUnenroll)
// and src/lib/backend.ts (updatePassword); this page only orchestrates UX.
//
// HONEST SCOPE (docs/04 gap 2): TOTP authenticator apps only. Recovery
// CODES and WebAuthn/phone factors are NOT implemented — a lost authenticator
// is recovered through the program office (documented on-screen), because
// account recovery for government accounts is an administrative process, not
// a self-service loop.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  mfaAal,
  mfaEnrollStart,
  mfaEnrollVerify,
  mfaListFactors,
  mfaUnenroll,
  updatePassword,
  type MfaAal,
  type MfaEnrollStart,
  type MfaFactor,
} from "@/lib/backend";
import { KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

function friendlyMfaError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : "";
  if (msg.includes("MFA_INVALID_CODE")) return "That code is not valid — check the authenticator and try again.";
  if (msg.includes("TOO_MANY_ATTEMPTS")) return "Too many attempts — wait a moment and try again.";
  if (msg.includes("MFA_NOT_FOUND")) return "That factor no longer exists.";
  if (msg.includes("WEAK_PASSWORD")) return "Password is too weak (use at least 6 characters).";
  return fallback;
}

export default function SecurityPage() {
  const [loading, setLoading] = useState(true);
  const [aal, setAal] = useState<MfaAal | null>(null);
  const [factors, setFactors] = useState<MfaFactor[]>([]);

  // Enrollment flow state
  const [enrolling, setEnrolling] = useState(false);
  const [start, setStart] = useState<MfaEnrollStart | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [busy, setBusy] = useState(false);

  // Password change state
  const [pw, setPw] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [level, list] = await Promise.all([mfaAal(), mfaListFactors()]);
      setAal(level);
      setFactors(list.filter((f) => f.status === "verified"));
    } catch (err) {
      console.error("Security state error:", err);
      toast.error("Could not load your security settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const beginEnroll = async () => {
    setBusy(true);
    try {
      const s = await mfaEnrollStart("Authenticator app");
      setStart(s);
      setEnrolling(true);
    } catch (err) {
      console.error("MFA enroll error:", err);
      toast.error(friendlyMfaError(err, "Could not start enrollment."));
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    if (!start) return;
    setBusy(true);
    try {
      await mfaEnrollVerify(start.factorId, enrollCode);
      toast.success("Two-factor authentication is now active.");
      setEnrolling(false);
      setStart(null);
      setEnrollCode("");
      await refresh();
    } catch (err) {
      console.error("MFA verify error:", err);
      toast.error(friendlyMfaError(err, "Could not verify the code."));
    } finally {
      setBusy(false);
    }
  };

  const removeFactor = async (factorId: string) => {
    setBusy(true);
    try {
      await mfaUnenroll(factorId);
      toast.success("Two-factor authentication removed.");
      await refresh();
    } catch (err) {
      console.error("MFA unenroll error:", err);
      toast.error(friendlyMfaError(err, "Could not remove the factor."));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (pw.length < 6) {
      toast.error("Password is too weak (use at least 6 characters).");
      return;
    }
    if (pw !== pwConfirm) {
      toast.error("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await updatePassword(pw);
      toast.success("Password updated.");
      setPw("");
      setPwConfirm("");
    } catch (err) {
      console.error("Password update error:", err);
      toast.error(friendlyMfaError(err, "Could not update the password."));
    } finally {
      setBusy(false);
    }
  };

  const mfaActive = factors.length > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="display text-2xl">Account security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two-factor authentication and password management. All changes are
          yours alone to make — the program office cannot see or set your codes.
        </p>
      </div>

      {/* --- Two-factor status + enrollment --- */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardHeader className="pb-2">
          <p className="kicker">Multi-factor</p>
          <CardTitle className="display flex items-center gap-2 text-lg">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mfaActive ? (
              <>
                <ShieldCheck className="h-5 w-5 text-primary" strokeWidth={1.5} />
                Two-factor authentication is active
              </>
            ) : (
              <>
                <ShieldOff className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
                Two-factor authentication is off
              </>
            )}
          </CardTitle>
          <CardDescription>
            {mfaActive
              ? "Sign-ins from a new session will ask for an authenticator code after your password."
              : "Add a TOTP authenticator app (Aegis, Google Authenticator, 1Password…) as a second sign-in factor."}
          </CardDescription>
        </CardHeader>

        {!enrolling && (
          <CardContent className="space-y-2">
            {factors.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between rounded border border-border bg-muted/40 px-3 py-2"
              >
                <div className="text-sm">
                  <p className="font-medium">{f.friendlyName ?? "Authenticator app"}</p>
                  <p className="text-xs text-muted-foreground">
                    TOTP · verified{f.createdAt ? ` · added ${new Date(f.createdAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void removeFactor(f.id)}
                >
                  Remove
                </Button>
              </div>
            ))}
            {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          </CardContent>
        )}

        {enrolling && start ? (
          <CardContent className="space-y-3">
            <p className="text-sm">
              1. Add the secret to your authenticator app (manual entry):
            </p>
            <div className="break-all rounded border border-border bg-muted/40 p-3 font-mono text-sm tracking-widest">
              {start.secret ?? "(secret unavailable)"}
            </div>
            {start.uri && (
              <p className="text-xs text-muted-foreground">
                Or paste this otpauth:// URI into a password manager that
                supports TOTP.
              </p>
            )}
            <p className="text-sm">2. Enter the 6-digit code it shows:</p>
            <Input
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              disabled={busy}
            />
            {start.qr && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={start.qr} alt="Authenticator QR code" className="max-w-40 self-center" />
            )}
          </CardContent>
        ) : null}

        <CardFooter className="flex-col gap-2">
          {enrolling && start ? (
            <>
              <Button className="w-full" disabled={busy || enrollCode.length !== 6} onClick={() => void confirmEnroll()}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" strokeWidth={1.5} />}
                Verify and activate
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => {
                  setEnrolling(false);
                  setStart(null);
                  setEnrollCode("");
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            !mfaActive && (
              <Button className="w-full" disabled={busy || loading} onClick={() => void beginEnroll()}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" strokeWidth={1.5} />}
                Set up authenticator app
              </Button>
            )
          )}
        </CardFooter>
      </Card>

      {/* --- Password change --- */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardHeader className="pb-2">
          <p className="kicker">Password</p>
          <CardTitle className="display text-lg">Change your password</CardTitle>
          <CardDescription>
            Use this, or the “forgot password” link on the sign-in page, which
            sends a recovery email (if email delivery is configured for the
            project).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="New password (min. 6 characters)"
            autoComplete="new-password"
            minLength={6}
            disabled={busy}
          />
          <Input
            type="password"
            value={pwConfirm}
            onChange={(e) => setPwConfirm(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
            disabled={busy}
          />
        </CardContent>
        <CardFooter>
          <Button className="w-full" disabled={busy || !pw} onClick={() => void changePassword()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" strokeWidth={1.5} />}
            Update password
          </Button>
        </CardFooter>
      </Card>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Lost access to your authenticator? Contact the program office to have
        the factor removed administratively — then sign in with your password
        and enroll again. Assurance level now: {aal?.current ?? "—"}
        {aal?.next === "aal2" ? " (this account requires two factors)" : ""}.
      </p>
    </div>
  );
}
