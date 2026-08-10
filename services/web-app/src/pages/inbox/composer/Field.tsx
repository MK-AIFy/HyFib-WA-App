import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

/** Label + control + inline validation error, matching the LoginPage field pattern. */
export function Field({
  label,
  id,
  error,
  children
}: {
  label: string;
  id: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
