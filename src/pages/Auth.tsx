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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import { useAuth } from "@/hooks/use-auth";
import {
  mfaAal,
  resetPasswordEmail,
  signInEmailMfaAware,
  updatePassword,
} from "@/lib/backend";
import { ArrowRight, KeyRound, Loader2, Mail, ShieldCheck, UserX } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/portal",
  role?: string | null,
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  // No explicit returnTo: land each identity in its OWN section (§20).
  if (role === "operator") return "/operate";
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const {
    isLoading: authLoading,
    isAuthenticated,
    user,
    signInEmail,
    signUpEmail,
    signInGuest,
    signOut,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
    user?.role ?? null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Password-recovery mode (deep link from the recovery email) and the
  // "forgot password" request panel are part of this page — Gap #4.
  const isRecovery = searchParams.get("mode") === "reset";
  const [showForgot, setShowForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  // MFA challenge state: after a password sign-in on an MFA-enrolled account.
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  // Auth errors arrive as plain-message Errors from the Supabase layer
  // (src/lib/backend.ts authErrorMessage) — match on message text.
  const authMessage = (err: unknown, fallback: string) => {
    const msg = err instanceof Error ? err.message : "";
    if (
      msg.includes("Incorrect email or password") ||
      msg.includes("invalid login credentials")
    )
      return "Incorrect email or password.";
    if (msg.includes("No account with that email"))
      return "No account with that email.";
    if (msg.includes("already exists"))
      return "An account already exists with that email — sign in instead.";
    if (msg.includes("too weak"))
      return "Password is too weak (use at least 6 characters).";
    if (msg.includes("Too many attempts") || msg.includes("rate limit"))
      return "Too many attempts — please wait a moment and try again.";
    if (msg.includes("Email not confirmed"))
      return "Email not confirmed yet. Check your inbox.";
    if (msg.includes("CONFIRM_EMAIL:"))
      return msg.replace("CONFIRM_EMAIL: ", "");
    if (msg.includes("ANON_DISABLED:"))
      return "Guest sign-in is not enabled for this project.";
    return fallback;
  };

  const handleSignIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    const fd = new FormData(event.currentTarget);
    try {
      const { mfaRequired: needsMfa } = await signInEmailMfaAware(
        String(fd.get("email") ?? "").trim(),
        String(fd.get("password") ?? ""),
      );
      if (needsMfa) {
        setMfaRequired(true);
        setIsLoading(false);
        return; // the authenticator-code step completes the sign-in
      }
      navigate(redirect);
    } catch (err) {
      console.error("Sign-in error:", err);
      setError(authMessage(err, "Failed to sign in. Please try again."));
      setIsLoading(false);
    }
  };

  const handleMfaVerify = async () => {
    setMfaBusy(true);
    setMfaError(null);
    try {
      const aal = await mfaAal();
      if (aal.current !== "aal2") {
        setMfaError("That code did not verify — try again.");
        setMfaBusy(false);
        return;
      }
      navigate(redirect);
    } catch (err) {
      console.error("MFA verify error:", err);
      setMfaError(
        err instanceof Error && err.message.includes("TOO_MANY_ATTEMPTS")
          ? "Too many attempts — wait a moment and try again."
          : "That code did not verify — try again.",
      );
      setMfaBusy(false);
    }
  };

  const handleForgot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await resetPasswordEmail(String(new FormData(event.currentTarget).get("email") ?? "").trim());
      setForgotSent(true);
    } catch (err) {
      console.error("Password reset error:", err);
      setError(authMessage(err, "Could not send the reset email."));
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    const fd = new FormData(event.currentTarget);
    const pw = String(fd.get("password") ?? "");
    if (pw !== String(fd.get("confirm") ?? "")) {
      setError("Passwords do not match.");
      setIsLoading(false);
      return;
    }
    try {
      await updatePassword(pw);
      setSearchParams({}, { replace: true });
      setNotice("Password updated — you are signed in.");
      navigate(redirect);
    } catch (err) {
      console.error("Password set error:", err);
      setError(authMessage(err, "Could not set the new password."));
      setIsLoading(false);
    }
  };

  const handleSignUp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    const fd = new FormData(event.currentTarget);
    const password = String(fd.get("password") ?? "");
    if (password !== String(fd.get("confirm") ?? "")) {
      setError("Passwords do not match.");
      setIsLoading(false);
      return;
    }
    try {
      await signUpEmail(
        String(fd.get("email") ?? "").trim(),
        password,
        String(fd.get("name") ?? "").trim() || undefined,
      );
      navigate(redirect);
    } catch (err) {
      console.error("Sign-up error:", err);
      setError(authMessage(err, "Failed to create the account."));
      setIsLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signInGuest();
      navigate(redirect);
    } catch (err) {
      console.error("Guest login error:", err);
      setError(
        authMessage(err, "Failed to sign in as guest."),
      );
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background paper-grain">
      <div className="flex-1">
        <div className="mx-auto flex h-full w-full max-w-md flex-col justify-center px-4 py-16">
          <Link to="/" className="mb-8 flex items-center justify-center gap-2">
            <ShieldCheck className="size-6" strokeWidth={1.5} />
            <span className="display text-xl">MineGuard Liberia</span>
          </Link>

          <Card className="paper rounded-none border-border shadow-none">
            {isRecovery ? (
              /* ------------------------------------------------ recovery link landed */
              <form onSubmit={handleNewPassword}>
                <CardHeader className="pb-2 text-center">
                  <p className="kicker">Account recovery</p>
                  <CardTitle className="display mt-1 text-2xl">Set a new password</CardTitle>
                  <CardDescription>
                    Choose a new password for your account. The recovery link
                    signed you in once for exactly this purpose.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Input
                    name="password"
                    type="password"
                    placeholder="New password (min. 6 characters)"
                    aria-label="New password"
                    autoComplete="new-password"
                    minLength={6}
                    disabled={isLoading}
                    required
                  />
                  <Input
                    name="confirm"
                    type="password"
                    placeholder="Confirm new password"
                    aria-label="Confirm new password"
                    autoComplete="new-password"
                    disabled={isLoading}
                    required
                  />
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </CardContent>
                <CardFooter>
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" strokeWidth={1.5} />}
                    Set password and continue
                  </Button>
                </CardFooter>
              </form>
            ) : mfaRequired ? (
              /* ------------------------------------------------ MFA challenge step */
              <div>
                <CardHeader className="pb-2 text-center">
                  <p className="kicker">Two-factor verification</p>
                  <CardTitle className="display mt-1 text-2xl">Enter authenticator code</CardTitle>
                  <CardDescription>
                    Your account requires a second factor. Enter the 6-digit code
                    from your authenticator app to finish signing in.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Input
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="123456"
                    aria-label="6-digit authenticator code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    disabled={mfaBusy}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && mfaCode.length === 6) void handleMfaVerify();
                    }}
                  />
                  {mfaError && <p className="text-sm text-destructive">{mfaError}</p>}
                </CardContent>
                <CardFooter className="flex-col gap-2">
                  <Button
                    className="w-full"
                    disabled={mfaBusy || mfaCode.length !== 6}
                    onClick={() => void handleMfaVerify()}
                  >
                    {mfaBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" strokeWidth={1.5} />}
                    Verify code
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={async () => {
                      await signOut();
                      setMfaRequired(false);
                      setMfaCode("");
                      setMfaError(null);
                    }}
                  >
                    Back to sign-in
                  </Button>
                </CardFooter>
              </div>
            ) : showForgot ? (
              /* ------------------------------------------------ forgot-password request */
              <div>
                <CardHeader className="pb-2 text-center">
                  <p className="kicker">Account recovery</p>
                  <CardTitle className="display mt-1 text-2xl">Reset your password</CardTitle>
                  <CardDescription>
                    Enter your account email. If it exists and email delivery is
                    configured for the project, a recovery link is sent.
                  </CardDescription>
                </CardHeader>
                {forgotSent ? (
                  <CardContent className="space-y-3">
                    <p className="text-sm">
                      If an account exists for that address, a recovery email is
                      on its way. Follow its link to set a new password.
                    </p>
                    <Button variant="outline" className="w-full" onClick={() => setShowForgot(false)}>
                      Back to sign-in
                    </Button>
                  </CardContent>
                ) : (
                  <form onSubmit={handleForgot}>
                    <CardContent className="space-y-3">
                      <div className="relative">
                        <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="email"
                        type="email"
                        placeholder="name@example.gov"
                        aria-label="Email address"
                        className="pl-9"
                        autoComplete="email"
                        disabled={isLoading}
                        required
                      />
                      </div>
                      {error && <p className="text-sm text-destructive">{error}</p>}
                    </CardContent>
                    <CardFooter className="flex-col gap-2">
                      <Button type="submit" className="w-full" disabled={isLoading}>
                        {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" strokeWidth={1.5} />}
                        Send recovery email
                      </Button>
                      <Button type="button" variant="outline" className="w-full" onClick={() => setShowForgot(false)}>
                        Back to sign-in
                      </Button>
                    </CardFooter>
                  </form>
                )}
              </div>
            ) : (
            <Tabs defaultValue="signin">
              <CardHeader className="pb-2 text-center">
                <p className="kicker">Authorized personnel</p>
                <CardTitle className="display mt-1 text-2xl">
                  Staff sign-in
                </CardTitle>
                <CardDescription>
                  Accounts are provisioned by the program office. All sign-ins
                  are attributed in the audit trail.
                </CardDescription>
              </CardHeader>
              <TabsList className="mx-auto grid w-[calc(100%-3rem)] grid-cols-2">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Create account</TabsTrigger>
              </TabsList>

              <TabsContent value="signin">
                <form onSubmit={handleSignIn}>
                  <CardContent className="space-y-3">
                    <div className="relative">
                      <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="email"
                        placeholder="name@example.gov"
                        type="email"
                        aria-label="Email address"
                        className="pl-9"
                        autoComplete="email"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    <Input
                      name="password"
                      placeholder="Password"
                      type="password"
                      aria-label="Password"
                      autoComplete="current-password"
                      disabled={isLoading}
                      required
                    />
                    {error && (
                      <p className="text-sm text-destructive">{error}</p>
                    )}
                  </CardContent>
                  <CardFooter className="flex-col gap-2">
                    <Button type="submit" className="w-full" disabled={isLoading}>
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Signing in…
                        </>
                      ) : (
                        <>
                          Sign in
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className="w-full text-xs text-muted-foreground"
                      onClick={() => {
                        setShowForgot(true);
                        setError(null);
                      }}
                      disabled={isLoading}
                    >
                      Forgot your password?
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={handleGuestLogin}
                      disabled={isLoading}
                    >
                      <UserX className="mr-2 h-4 w-4" />
                      Continue as guest
                    </Button>
                  </CardFooter>
                </form>
              </TabsContent>

              <TabsContent value="signup">
                <form onSubmit={handleSignUp}>
                  <CardContent className="space-y-3">
                    <Input
                      name="name"
                      placeholder="Full name"
                      aria-label="Full name"
                      autoComplete="name"
                      disabled={isLoading}
                      required
                    />
                    <Input
                      name="email"
                      placeholder="name@example.gov"
                      type="email"
                      aria-label="Email address"
                      autoComplete="email"
                      disabled={isLoading}
                      required
                    />
                    <Input
                      name="password"
                      placeholder="Password (min. 6 characters)"
                      type="password"
                      aria-label="Password"
                      autoComplete="new-password"
                      minLength={6}
                      disabled={isLoading}
                      required
                    />
                    <Input
                      name="confirm"
                      placeholder="Confirm password"
                      aria-label="Confirm password"
                      type="password"
                      autoComplete="new-password"
                      disabled={isLoading}
                      required
                    />
                    {error && (
                      <p className="text-sm text-destructive">{error}</p>
                    )}
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      New accounts start with no platform role. The first staff
                      profile completed becomes the administrator; later accounts
                      must be assigned a role by an administrator.
                    </p>
                  </CardContent>
                  <CardFooter>
                    <Button type="submit" className="w-full" disabled={isLoading}>
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Creating account…
                        </>
                      ) : (
                        <>
                          Create account
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </form>
              </TabsContent>
            </Tabs>
            )}

            <div className="rounded-b-lg border-t border-border bg-muted px-6 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              Access is for authorized oversight operations.
              {notice ? ` ${notice}` : ""}
            </div>
          </Card>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Not an official Government of Liberia system. Designed for potential
            government adoption.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
