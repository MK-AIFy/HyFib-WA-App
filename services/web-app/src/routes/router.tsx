import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "@/components/layout/AppLayout";
import { useSse } from "@/hooks/use-sse";
import { useAuth } from "@/lib/auth-context";
import { LoginPage } from "@/pages/LoginPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { ContactsPage } from "@/pages/ContactsPage";
import { SegmentsPage } from "@/pages/SegmentsPage";
import { CampaignsPage } from "@/pages/CampaignsPage";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { TasksPage } from "@/pages/TasksPage";
import { AutomationPage } from "@/pages/AutomationPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { UsagePage } from "@/pages/UsagePage";
import { AiToolsPage } from "@/pages/AiToolsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TeamsPage } from "@/pages/TeamsPage";
import { UsersPage } from "@/pages/UsersPage";
import { RequireAuth, RequireRole } from "./guards";

function ShellRoute() {
  const { user, logout } = useAuth();
  const sseStatus = useSse(Boolean(user));

  if (!user) {
    // RequireAuth (the parent route) guarantees this never renders, but
    // keeps this component's props well-typed without a non-null assertion.
    return null;
  }

  return (
    <AppLayout
      roles={user.roles}
      tenantName={user.tenant?.name ?? user.tenantId}
      displayName={user.displayName}
      role={user.roles[0] ?? ""}
      sseStatus={sseStatus}
      onLogout={() => void logout()}
    />
  );
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/onboarding", element: <OnboardingPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: "/",
        element: <ShellRoute />,
        children: [
          { index: true, element: <Navigate to="/inbox" replace /> },
          { path: "inbox", element: <InboxPage /> },
          { path: "contacts", element: <ContactsPage /> },
          { path: "segments", element: <SegmentsPage /> },
          { path: "campaigns", element: <CampaignsPage /> },
          { path: "templates", element: <TemplatesPage /> },
          { path: "tasks", element: <TasksPage /> },
          { path: "automation", element: <AutomationPage /> },
          { path: "teams", element: <TeamsPage /> },
          { path: "analytics", element: <AnalyticsPage /> },
          { path: "reports", element: <ReportsPage /> },
          { path: "usage", element: <UsagePage /> },
          { path: "ai-tools", element: <AiToolsPage /> },
          {
            element: <RequireRole roles={["platform_owner", "tenant_admin"]} />,
            children: [{ path: "users", element: <UsersPage /> }]
          },
          { path: "settings", element: <SettingsPage /> }
        ]
      }
    ]
  }
]);
