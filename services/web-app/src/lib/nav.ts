import type { Role } from "@hyfib/shared-core";
import {
  BarChart3,
  Bot,
  CheckSquare,
  Inbox,
  LineChart,
  Megaphone,
  Settings,
  Target,
  UserCog,
  Users,
  UsersRound,
  Wallet,
  Zap,
  type LucideIcon
} from "lucide-react";

export interface NavItem {
  id: string;
  to: string;
  label: string;
  icon: LucideIcon;
}

const BASE_NAV: NavItem[] = [
  { id: "inbox", to: "/inbox", label: "Inbox", icon: Inbox },
  { id: "contacts", to: "/contacts", label: "Contacts", icon: Users },
  { id: "segments", to: "/segments", label: "Segments", icon: Target },
  { id: "campaigns", to: "/campaigns", label: "Campaigns", icon: Megaphone },
  { id: "tasks", to: "/tasks", label: "Tasks", icon: CheckSquare },
  { id: "automation", to: "/automation", label: "Automation", icon: Zap },
  { id: "teams", to: "/teams", label: "Teams", icon: UsersRound },
  { id: "analytics", to: "/analytics", label: "Analytics", icon: BarChart3 },
  { id: "reports", to: "/reports", label: "Reports", icon: LineChart },
  { id: "usage", to: "/usage", label: "Usage", icon: Wallet },
  { id: "ai-tools", to: "/ai-tools", label: "AI Tools", icon: Bot }
];

const USERS_NAV: NavItem = { id: "users", to: "/users", label: "Users", icon: UserCog };
const SETTINGS_NAV: NavItem = { id: "settings", to: "/settings", label: "Settings", icon: Settings };

/**
 * Mirrors the visibility matrix in the vanilla-JS portal (index.html:1157-1173):
 * "Users" is visible to platform_owner/tenant_admin. The platform-level "Tenants"
 * console was removed as part of the single-org hardening (see /auth/register 410
 * and the retired /api/v1/tenants routes).
 */
export function getNavItems(roles: Role[]): NavItem[] {
  const isAdmin = roles.some((r) => r === "platform_owner" || r === "tenant_admin");

  return [...BASE_NAV, ...(isAdmin ? [USERS_NAV] : []), SETTINGS_NAV];
}
