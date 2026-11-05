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

  const finished = await finishLogin(deps, user.id, prepared, true);
  if (finished.status !== 200) return finished;
  return { status: 200, body: { deleted: true, mode: finished.body.mode } };
}

/** Acts on the LOGIN after the database has accepted and prepared the removal. */
async function finishLogin(
  deps: AccountDeps,
  targetId: string,
  prepared: { avatarPath?: string | null; hasRecords?: boolean },
  endSessions: boolean,
): Promise<AccountResult> {
  if (prepared.avatarPath) {
    try {
      await deps.admin.removeAvatar(prepared.avatarPath);
    } catch {
      /* the profile no longer points at it; a leftover file is private and harmless */
    }
  }
  let mode: "removed" | "anonymized" = "anonymized";
  if (prepared.hasRecords === false) {
    const del = await deps.admin.deleteUser(targetId);
    if (!del.error) mode = "removed";
  }
  if (mode === "anonymized") {
    const off = await deps.admin.disableUser(targetId);
    if (off.error) {
      // The profile is already scrubbed and has no role, so nothing sensitive remains reachable;
      // running it again is safe and finishes the job.
      return {
        status: 500,
        body: { error: "INCOMPLETE", message: "The details were removed but sign-in could not be disabled. Please try again." },
      };
    }
  }
  if (endSessions) await deps.admin.endSessions().catch(() => undefined);
  return { status: 200, body: { mode } };
}

/**
 * An ADMINISTRATOR removes SOMEONE ELSE's account. Same order of safety: the administrator
 * proves who they are now (typed confirmation + their own password), the database checks
 * authority, blockers and the typed email and prepares, then the login is acted on.
 */
export async function handleAdminAccountRemoval(
  deps: AccountDeps,
  admin: { id: string; email: string | null },
  body: unknown,
): Promise<AccountResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!admin.email) {
    return { status: 400, body: { error: "NO_PASSWORD_LOGIN", message: "This account cannot do that here." } };
  }
  if (b.confirm !== "DELETE") {
    return { status: 400, body: { error: "CONFIRM_REQUIRED", message: "Type DELETE to confirm." } };
  }
  if (typeof b.targetUserId !== "string" || !UUID.test(b.targetUserId)) {
    return { status: 400, body: { error: "BAD_REQUEST", message: "Choose the account to remove." } };
  }
  if (typeof b.confirmEmail !== "string" || b.confirmEmail.length < 3 || b.confirmEmail.length > 254) {
    return { status: 400, body: { error: "CONFIRM_MISMATCH", message: "Type the account's exact email address." } };
  }
  if (typeof b.password !== "string" || b.password.length < 1 || b.password.length > 256) {
    return { status: 400, body: { error: "PASSWORD_REQUIRED", message: "Enter your password." } };
  }
  if (b.targetUserId === admin.id) {
    return { status: 400, body: { error: "USE_SELF_SERVICE", message: "Delete your own account from My profile." } };
  }
  if (!(await deps.verifyPassword(admin.email, b.password))) {
    return { status: 403, body: { error: "WRONG_PASSWORD", message: "That password is not correct." } };
  }

  const prep = await deps.db.rpc("mg_admin_prepare_account_deletion", {
    p_target: b.targetUserId,
    p_confirm_email: b.confirmEmail,
  });
  if (prep.error) {
    const m = prep.error.message;
    const table: [string, number, string][] = [
      ["BLOCKED", 409, "BLOCKED"],
      ["CONFIRM_MISMATCH", 400, "CONFIRM_MISMATCH"],
      ["USE_SELF_SERVICE", 400, "USE_SELF_SERVICE"],
      ["FORBIDDEN", 403, "FORBIDDEN"],
      ["NOT_FOUND", 404, "NOT_FOUND"],
    ];
    for (const [prefix, status, code] of table) {
      if (m.startsWith(prefix)) return { status, body: { error: code, message: m.replace(/^[A-Z_]+:?\s*/, "") || code } };
    }
    return { status: 500, body: { error: "INTERNAL", message: "The account could not be removed. Nothing was changed." } };
  }
  const finished = await finishLogin(deps, b.targetUserId, (prep.data ?? {}) as { avatarPath?: string | null; hasRecords?: boolean }, false);
  if (finished.status !== 200) return finished;
  return { status: 200, body: { removed: true, mode: finished.body.mode } };
}
