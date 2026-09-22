import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

/**
 * Wraps staff-only portal sections. Signed-in non-staff users (operators,
 * unassigned accounts) get an explanatory card instead of a spinner that
 * would never resolve — staff-only queries are denied by the security rules,
 * and a denied read surfaces as "still loading" in the query layer.
 */
export function StaffOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  // Profile still loading — render nothing briefly rather than flashing the
  // denial card before the role is known.
  if (!user) return null;

  const isStaff =
    user.role === "admin" ||
    user.role === "supervisor" ||
    user.role === "inspector";

  if (isStaff) return <>{children}</>;

  return (
    <div className="paper flex items-start gap-3 p-6">
      <ShieldAlert
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.5}
      />
      <div>
        <p className="text-sm font-medium">Staff access required</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          This section is limited to MineGuard staff roles (admin, supervisor,
          inspector). Your current role: {user.role ?? "unassigned"}. Ask a
          platform administrator to assign a role to {user.email ?? "your account"}.
        </p>
      </div>
    </div>
  );
}
