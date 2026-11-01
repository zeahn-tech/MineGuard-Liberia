// ---------------------------------------------------------------------------
// Self-service account deletion (migration 0035). Pure logic over injected
// dependencies so it is testable without a Deno runtime.
//
// Order matters and is the whole safety story:
//   1. the person must prove it is them NOW: typed confirmation + their password
//      (a stolen session alone cannot delete an account);
//   2. the DATABASE decides whether deletion is allowed (blockers) and does the
//      irreversible-but-safe part as the CALLER: ends company memberships, clears the
//      inbox, scrubs personal details, and reports whether the person owns records;
//   3. only then the privileged client acts on the LOGIN: delete it outright when the
//      person owns no records, otherwise disable + anonymize it (safety records keep
//      their history under "Deleted user"). Neither path ever deletes a safety record.
// No password, email address or token is ever logged or returned.
// ---------------------------------------------------------------------------

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}
export interface AccountDeps {
  /** Client scoped to the CALLER's JWT: the database authorizes everything. */
  db: { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> };
  /** Re-verifies the password of this account (never trusts the existing session alone). */
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** Service-role actions, reached only after the database has accepted the request. */
  admin: {
    removeAvatar(path: string): Promise<void>;
    deleteUser(id: string): Promise<{ error: { message: string } | null }>;
    disableUser(id: string): Promise<{ error: { message: string } | null }>;
    endSessions(): Promise<void>;
  };
}
export interface AccountResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleAccountDeletion(
  deps: AccountDeps,
  user: { id: string; email: string | null },
  body: unknown,
): Promise<AccountResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!user.email) {
    return { status: 400, body: { error: "NO_PASSWORD_LOGIN", message: "This account cannot be deleted here." } };
  }
  if (b.confirm !== "DELETE") {
    return { status: 400, body: { error: "CONFIRM_REQUIRED", message: "Type DELETE to confirm." } };
  }
  if (typeof b.password !== "string" || b.password.length < 1 || b.password.length > 256) {
    return { status: 400, body: { error: "PASSWORD_REQUIRED", message: "Enter your password." } };
  }

  // 1. who is asking — proven now
  if (!(await deps.verifyPassword(user.email, b.password))) {
    return { status: 403, body: { error: "WRONG_PASSWORD", message: "That password is not correct." } };
  }

  // 2. the database decides, then prepares
  const prep = await deps.db.rpc("mg_prepare_account_deletion");
  if (prep.error) {
    const m = prep.error.message;
    if (m.startsWith("BLOCKED")) {
      return { status: 409, body: { error: "BLOCKED", message: m.replace(/^BLOCKED:\s*/, "") } };
    }
    if (m.startsWith("UNAUTHENTICATED")) {
      return { status: 401, body: { error: "UNAUTHENTICATED", message: "Sign in again." } };
    }
    return { status: 500, body: { error: "INTERNAL", message: "The account could not be deleted. Nothing was removed." } };
  }
  const prepared = (prep.data ?? {}) as { avatarPath?: string | null; hasRecords?: boolean };

  // 3. the login
  if (prepared.avatarPath) {
    try {
      await deps.admin.removeAvatar(prepared.avatarPath);
    } catch {
      /* the profile no longer points at it; a leftover file is private and harmless */
    }
  }
  let mode: "removed" | "anonymized" = "anonymized";
  if (prepared.hasRecords === false) {
    const del = await deps.admin.deleteUser(user.id);
    if (!del.error) mode = "removed";
  }
  if (mode === "anonymized") {
    const off = await deps.admin.disableUser(user.id);
    if (off.error) {
      // The profile is already scrubbed and has no role, so nothing sensitive remains reachable;
      // running it again is safe and finishes the job.
      return {
        status: 500,
        body: { error: "INCOMPLETE", message: "Your details were removed but sign-in could not be disabled. Please try again." },
      };
    }
  }
  await deps.admin.endSessions().catch(() => undefined);
  return { status: 200, body: { deleted: true, mode } };
}
