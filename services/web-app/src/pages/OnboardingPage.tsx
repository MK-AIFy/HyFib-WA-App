import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Navigate, useNavigate } from "react-router";
import { z } from "zod";
import type { WhatsAppChannel } from "@hyfib/shared-core";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { writeChannel } from "@/lib/auth-storage";

const schema = z.object({
  wabaId: z.string().min(1, "WABA ID is required"),
  phoneNumberId: z.string().min(1, "Phone Number ID is required"),
  displayPhoneNumber: z.string().min(1, "Display Phone Number is required"),
  accessToken: z.string().optional()
});

type FormValues = z.infer<typeof schema>;

export function OnboardingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting }
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  function goToApp() {
    void navigate("/inbox", { replace: true });
  }

  async function onSubmit(values: FormValues) {
    try {
      const channel = await api.post<WhatsAppChannel>("/api/v1/channels/whatsapp", {
        wabaId: values.wabaId,
        phoneNumberId: values.phoneNumberId,
        displayPhoneNumber: values.displayPhoneNumber,
        accessToken: values.accessToken || undefined
      });
      writeChannel(channel.id, channel.displayPhoneNumber);
      goToApp();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Something went wrong. Try again.";
      setError("root", { message });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Connect WhatsApp</CardTitle>
          <CardDescription>
            Find these values in Meta Business Manager → WhatsApp → API Setup. The access token is your System User
            permanent token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate>
            {errors.root ? (
              <Alert variant="destructive">
                <AlertDescription>{errors.root.message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wabaId">WABA ID</Label>
              <Input id="wabaId" aria-invalid={!!errors.wabaId} {...register("wabaId")} />
              {errors.wabaId ? <p className="text-xs text-destructive">{errors.wabaId.message}</p> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phoneNumberId">Phone Number ID</Label>
              <Input id="phoneNumberId" aria-invalid={!!errors.phoneNumberId} {...register("phoneNumberId")} />
              {errors.phoneNumberId ? (
                <p className="text-xs text-destructive">{errors.phoneNumberId.message}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="displayPhoneNumber">Display Phone Number</Label>
              <Input
                id="displayPhoneNumber"
                placeholder="+15551234567"
                aria-invalid={!!errors.displayPhoneNumber}
                {...register("displayPhoneNumber")}
              />
              {errors.displayPhoneNumber ? (
                <p className="text-xs text-destructive">{errors.displayPhoneNumber.message}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="accessToken">Permanent access token</Label>
              <Input id="accessToken" type="password" {...register("accessToken")} />
            </div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Connecting…" : "Connect"}
            </Button>
            <Button type="button" variant="ghost" onClick={goToApp}>
              Skip for now
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
