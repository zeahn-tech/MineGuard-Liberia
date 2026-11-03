// ---------------------------------------------------------------------------
// SIGN-IN FAILURES — the words a person sees when signing in does not work.
//
// Three situations look the same from the outside ("it didn't let me in") but
// need different words, and none of them may show a raw service message such as
// "Database error querying schema":
//
//  * CREDENTIALS  No account matches this email + password. This is also exactly
//                 what a DELETED account looks like: deleting releases the login,
//                 so the old email simply does not exist any more. We say so and
//                 offer to create an account. We deliberately say "email and
//                 password" together and do not confirm which half was wrong:
//                 telling strangers which emails are registered is an
//                 account-enumeration leak.
//  * DISABLED     The login exists but has been closed.
//  * SERVICE      The sign-in service itself failed. Not the person's fault, and
//                 we cannot know whether the account exists, so the copy offers
//                 both ways forward (try again / create an account) without
//                 claiming either.
//
// Pure, so every sentence is unit-tested.
// ---------------------------------------------------------------------------

export interface AuthFailure {
  /** One short paragraph: what happened and what to do. */
  message: string;
  /** Show a "Create an account" way forward under the message. */
  offerSignUp: boolean;
}

const CREDENTIALS =
  /INCORRECT_CREDENTIALS|invalid login credentials|incorrect email or password|no account with that email/i;
const DISABLED = /ACCOUNT_DISABLED|user is banned|user_banned|\bbanned\b/i;
const SERVICE = /AUTH_SERVICE_ERROR|database error|querying schema|unexpected_failure|internal server error/i;

export function authFailure(raw: string): AuthFailure | null {
  if (!raw) return null;
  if (DISABLED.test(raw)) {
    return {
      message:
        "This account has been closed and can't be used to sign in. If you closed it yourself, you can create a new account.",
      offerSignUp: true,
    };
  }
  if (CREDENTIALS.test(raw)) {
    return {
      message:
        "We couldn't find an account with that email and password. Check them and try again, or create an account if you're new.",
      offerSignUp: true,
    };
  }
  if (SERVICE.test(raw)) {
    return {
      message:
        "We couldn't sign you in just now. If you don't have an account yet, or yours was deleted, create a new one. Otherwise, try again in a moment.",
      offerSignUp: true,
    };
  }
  return null;
}
