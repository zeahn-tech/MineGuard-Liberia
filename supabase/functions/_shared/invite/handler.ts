// ---------------------------------------------------------------------------
// Company-administrator invitation handler (Phase B). Pure logic over injected
// dependencies so it is unit/integration-testable without a Deno runtime.
//
// Security properties:
//   * AUTHORIZATION happens in the database: both RPCs run as the CALLER (their
//     JWT) and require organizations.write. The privileged mail client is only
//     reached AFTER the RPCs succeed, so a non-administrator can never cause an
//     email to be sent.
//   * The invited address comes from the database row, never from the request
//     body on resend; the redirect target is server configuration, never a
//     request value (no open redirect / phishing link).
//   * No invitation secret exists: the invite/magic link is Supabase Auth's own
//     one-time link; acceptance additionally requires the verified-email match
//     enforced by mg_accept_invitation. Email addresses are never logged.
// ---------------------------------------------------------------------------

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}
export interface InviteDeps {
  /** Client scoped to the CALLER's JWT (RLS + permission checks apply). */
  db: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> };
  mail: {
    /** auth.admin.inviteUserByEmail (service role). */
    invite(email: string, redirectTo: string): Promise<{ error: { message: string; status?: number } | null }>;
    /** One-time sign-in link for an address that already has an account. */
    magicLink(email: string, redirectTo: string): Promise<{ error: { message: string } | null }>;
  };
  /** Fixed by server configuration. */
  redirectTo: string | null;
}

export interface InviteResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUS_BY_CODE: Record<string, number> = {
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  INVALID_EMAIL: 400,
  INVALID_NAME: 400,
  ORG_NOT_APPROVED: 409,
  INELIGIBLE_ACCOUNT: 409,
  ALREADY_MEMBER_OTHER_ORG: 409,
  INVITATION_NOT_PENDING: 409,
  INVITATION_EXPIRED: 410,
  RESEND_TOO_SOON: 429,
  SEND_LIMIT: 429,
};

function fromDbError(message: string): InviteResult {
  const code = /^([A-Z_]+)/.exec(message)?.[1] ?? "";
  const status = STATUS_BY_CODE[code];
  if (!status) return { status: 500, body: { error: "INTERNAL", message: "The invitation could not be processed" } };
  const text = message.replace(/^[A-Z_]+:?\s*/, "");
  return { status, body: { error: code, message: text || code } };
}

export async function handleInviteRequest(deps: InviteDeps, body: unknown): Promise<InviteResult> {
  if (!deps.redirectTo) {
    return { status: 500, body: { error: "NOT_CONFIGURED", message: "Invitation email is not configured" } };
  }
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  let invitationId: string;
  if (typeof b.invitationId === "string") {
    if (!UUID.test(b.invitationId)) return { status: 400, body: { error: "BAD_REQUEST", message: "invitationId must be a UUID" } };
    invitationId = b.invitationId;
  } else if (typeof b.organizationId === "string" && typeof b.email === "string") {
    if (!UUID.test(b.organizationId)) return { status: 400, body: { error: "BAD_REQUEST", message: "organizationId must be a UUID" } };
    if (b.email.length > 254) return { status: 400, body: { error: "INVALID_EMAIL", message: "Enter a valid email address" } };
    const created = await deps.db.rpc("mg_create_company_admin_invitation", { p_org: b.organizationId, p_email: b.email });
    if (created.error) return fromDbError(created.error.message);
    invitationId = String(created.data);
  } else {
    return { status: 400, body: { error: "BAD_REQUEST", message: "Provide organizationId and email, or invitationId" } };
  }

  const prepared = await deps.db.rpc("mg_prepare_invitation_send", { p_id: invitationId });
  if (prepared.error) {
    const r = fromDbError(prepared.error.message);
    // The invitation exists even when the send is throttled: tell the UI which one.
    return { status: r.status, body: { ...r.body, invitationId } };
  }
  const email = String((prepared.data as { email?: unknown } | null)?.email ?? "");
  if (!email) return { status: 500, body: { error: "INTERNAL", message: "The invitation could not be processed", invitationId } };

  const invited = await deps.mail.invite(email, deps.redirectTo);
  if (!invited.error) return { status: 200, body: { invitationId, delivery: "invited" } };

  if (/already (been )?registered|already exists|email_exists/i.test(invited.error.message) || invited.error.status === 422) {
    const link = await deps.mail.magicLink(email, deps.redirectTo);
    if (!link.error) return { status: 200, body: { invitationId, delivery: "signin_link" } };
  }
  return {
    status: 502,
    body: { error: "EMAIL_FAILED", message: "The invitation was created but the email could not be sent. Try resending.", invitationId },
  };
}
