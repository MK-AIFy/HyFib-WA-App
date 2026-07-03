import { Outlet } from "react-router";
import type { Role } from "@hyfib/shared-core";
import { getNavItems } from "@/lib/nav";
import { Sidebar } from "./Sidebar";
import { Topbar, type SseStatus } from "./Topbar";

export interface AppLayoutProps {
  roles: Role[];
  tenantName: string;
  displayName: string;
  role: string;
  sseStatus: SseStatus;
  onLogout: () => void;
}

export function AppLayout({ roles, tenantName, displayName, role, sseStatus, onLogout }: AppLayoutProps) {
  const navItems = getNavItems(roles);

  return (
    <div className="flex h-screen flex-col">
      <Topbar
        navItems={navItems}
        tenantName={tenantName}
        displayName={displayName}
        role={role}
        sseStatus={sseStatus}
        onLogout={onLogout}
      />
      <a
        href="#main-content"
        className="sr-only rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-16 focus:z-50"
      >
        Skip to content
      </a>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar items={navItems} />
        <main id="main-content" className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
