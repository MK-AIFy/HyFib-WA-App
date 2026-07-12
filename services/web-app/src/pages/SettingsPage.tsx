import type { WhatsAppChannel } from "@hyfib/shared-core";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/lib/auth-context";
import { titleCase } from "@/lib/format";
import { useList } from "@/hooks/use-resource";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const { data } = useList<WhatsAppChannel>(["channels"], "/api/v1/channels/whatsapp");
  const channel = data?.items?.[0];
  const webhookUrl = `${window.location.origin}/api/v1/webhooks/meta/whatsapp`;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader title="Settings" description="Workspace and WhatsApp channel configuration." />
      <div className="grid gap-4 p-4 md:grid-cols-2 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label="Organization" value={user?.tenant?.name ?? "—"} />
            <Row label="Your role" value={titleCase(user?.roles[0] ?? "")} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp channel</CardTitle>
            <CardDescription>Connected number and status.</CardDescription>
          </CardHeader>
          <CardContent>
            {channel ? (
              <>
                <Row label="Display phone" value={channel.displayPhoneNumber} />
                <Row label="WABA ID" value={channel.wabaId} />
                <Row label="Phone number ID" value={channel.phoneNumberId} />
                <div className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={channel.status === "active" ? "green" : "gray"}>{channel.status}</Badge>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No channel connected yet.</p>
            )}
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Meta webhook</CardTitle>
            <CardDescription>Configure this callback URL in Meta Business Manager.</CardDescription>
          </CardHeader>
          <CardContent>
            <code className="block overflow-x-auto rounded-lg border border-border bg-secondary/40 p-3 text-xs">
              {webhookUrl}
            </code>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
