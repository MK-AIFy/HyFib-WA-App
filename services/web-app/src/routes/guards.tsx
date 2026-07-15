import { Navigate, Outlet } from "react-router";
import type { Role } from "@hyfib/shared-core";
import { useAuth } from "@/lib/auth-context";

export function RequireAuth() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
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
