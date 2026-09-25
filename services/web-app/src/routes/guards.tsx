import { Navigate, Outlet } from "react-router";
import type { Role } from "@hyfib/shared-core";
import { useAuth } from "@/lib/auth-context";

export function RequireAuth() {
  const { user, isLoading, isUnavailable } = useAuth();

  if (isLoading) {
    // An outage while the session is being checked is not a sign-out: say so, and keep the user here.
    return (
      <div role="status" className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        {isUnavailable ? "Can't reach the server. Retrying…" : "Loading…"}
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

export function RequireRole({ roles }: { roles: Role[] }) {
  const { user } = useAuth();
  const allowed = user ? user.roles.some((r) => roles.includes(r)) : false;

  if (!allowed) {
    return <Navigate to="/inbox" replace />;
  }
  return <Outlet />;
}
