// Landing for a tapped push notification (#/emergency/:id): send the person to the alert
// inside the right shell (staff portal or operator section) so the sync scheduler is running.
import { Navigate, useParams } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { AuthLoading } from "@/components/RequireAuth";

export default function EmergencyRedirect() {
  const { alertId = "" } = useParams();
  const { isLoading, isAuthenticated, user } = useAuth();
  if (isLoading) return <AuthLoading />;
  if (!isAuthenticated || !user) return <Navigate to="/auth" replace />;
  const staff = user.role === "admin" || user.role === "supervisor" || user.role === "inspector";
  return <Navigate to={`${staff ? "/portal" : "/operate"}/emergency/${alertId}`} replace />;
}
