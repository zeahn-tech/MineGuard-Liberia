import {
  api,
  fbSignInEmail,
  fbSignInGuest,
  fbSignOut,
  fbSignUpEmail,
} from "@/lib/backend";
import { useIsAuthenticated, useQuery } from "@/lib/backend-react";

export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useIsAuthenticated();
  const user = useQuery(() => api.users.currentUser());

  // undefined until profile loads; null profile = signed in but no doc.
  const isLoading = isAuthLoading || (isAuthenticated && user === undefined);

  return {
    isLoading,
    isAuthenticated,
    user,
    signIn: async (
      _provider: string,
      emailOrOpts?:
        | string
        | { email: string; password: string; name?: string },
      maybePassword?: string,
    ) => {
      // Convex-style call signature is not used by the new auth page; kept
      // flexible so legacy call sites compile.
      if (typeof emailOrOpts === "object" && emailOrOpts !== null) {
        if (emailOrOpts.email && emailOrOpts.password) {
          return fbSignInEmail(emailOrOpts.email, emailOrOpts.password);
        }
        return fbSignInGuest();
      }
      return fbSignInGuest();
    },
    signInEmail: fbSignInEmail,
    signUpEmail: fbSignUpEmail,
    signInGuest: fbSignInGuest,
    signOut: fbSignOut,
  };
}
