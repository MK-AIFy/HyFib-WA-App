import { ChevronDown, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/nav";
import { MobileNav } from "./MobileNav";

export type SseStatus = "live" | "offline" | "connecting";

export interface TopbarProps {
  navItems: NavItem[];
  tenantName: string;
  displayName: string;
  role: string;
  sseStatus: SseStatus;
  onLogout: () => void;
}

const SSE_LABEL: Record<SseStatus, string> = {
  live: "Live",
  offline: "Offline",
  connecting: "Connecting…"
};

const SSE_DOT_CLASS: Record<SseStatus, string> = {
  live: "bg-primary",
  offline: "bg-destructive",
  connecting: "bg-warn"
};

export function Topbar({ navItems, tenantName, displayName, role, sseStatus, onLogout }: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
      <MobileNav items={navItems} />
      <span className="text-sm font-semibold">HyFib</span>
      <span className="text-muted-foreground">·</span>
      <span className="truncate text-sm text-muted-foreground">{tenantName}</span>
      <div className="flex-1" />
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <span className={cn("size-2 rounded-full", SSE_DOT_CLASS[sseStatus])} aria-hidden="true" />
        <span>{SSE_LABEL[sseStatus]}</span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5">
            <span className="max-w-32 truncate">{displayName}</span>
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {role.replace(/_/g, " ")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onLogout} variant="destructive">
            <LogOut className="size-4" aria-hidden="true" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
