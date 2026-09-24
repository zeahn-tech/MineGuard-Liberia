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
import { ArrowRight, Loader2, Mail, ShieldCheck, UserX } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/portal",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const {
    isLoading: authLoading,
    isAuthenticated,
    signInEmail,
    signUpEmail,
    signInGuest,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await signInEmail(
        String(fd.get("email") ?? "").trim(),
        String(fd.get("password") ?? ""),
      );
      navigate(redirect);
    } catch (err) {
      console.error("Sign-in error:", err);
      setError(authMessage(err, "Failed to sign in. Please try again."));
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
                      autoComplete="name"
                      disabled={isLoading}
                      required
                    />
                    <Input
                      name="email"
                      placeholder="name@example.gov"
                      type="email"
                      autoComplete="email"
                      disabled={isLoading}
                      required
                    />
                    <Input
                      name="password"
                      placeholder="Password (min. 6 characters)"
                      type="password"
                      autoComplete="new-password"
                      minLength={6}
                      disabled={isLoading}
                      required
                    />
                    <Input
                      name="confirm"
                      placeholder="Confirm password"
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

            <div className="rounded-b-lg border-t border-border bg-muted px-6 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              Access is for authorized oversight operations.
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
