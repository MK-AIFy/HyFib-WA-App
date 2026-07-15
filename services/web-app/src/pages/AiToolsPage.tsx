import { useForm } from "react-hook-form";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";

interface DraftForm {
  objective: string;
  audienceDescription: string;
  offer: string;
  tone: string;
  language: string;
}

export function AiToolsPage() {
  const { register, handleSubmit, setValue } = useForm<DraftForm>({
    defaultValues: { tone: "professional", language: "English" }
  });
  const draft = useMutation({
    mutationFn: (body: DraftForm) => api.post<{ draft?: string }>("/api/v1/ai/campaign-draft", body),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed")
  });

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader title="AI Tools" description="Claude-powered drafting assistance (advisory only)." />
      <div className="p-4 md:p-6">
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Campaign draft generator</CardTitle>
            <CardDescription>Generate suggested campaign copy from your objective and offer.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit((v) => draft.mutate(v))(e)}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="objective">Objective</Label>
                <Input
                  id="objective"
                  placeholder="Re-engage lapsed customers"
                  {...register("objective", { required: true })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="audienceDescription">Audience</Label>
                <Input
                  id="audienceDescription"
                  placeholder="Customers inactive 30+ days"
                  {...register("audienceDescription", { required: true })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="offer">Offer</Label>
                <Input id="offer" placeholder="20% off next order" {...register("offer", { required: true })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Tone</Label>
                  <Select defaultValue="professional" onValueChange={(v) => setValue("tone", v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="language">Language</Label>
                  <Input id="language" {...register("language")} />
                </div>
              </div>
              <Button type="submit" disabled={draft.isPending} className="self-start">
                {draft.isPending ? "Generating…" : "Generate draft"}
              </Button>
            </form>
            {draft.data ? (
              <div className="mt-4 whitespace-pre-wrap rounded-lg border border-border bg-secondary/40 p-3 text-sm">
                {draft.data.draft ?? JSON.stringify(draft.data, null, 2)}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
