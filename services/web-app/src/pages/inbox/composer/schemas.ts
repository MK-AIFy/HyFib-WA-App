import { z } from "zod";
import type { WhatsAppContactCard } from "@hyfib/shared-core";
import type { SendMessageBody } from "@/hooks/use-conversations";

/**
 * Zod schemas + payload mappers for the composer dialogs. The schemas mirror
 * the gateway's per-kind validation bounds EXACTLY so the client rejects before
 * the server does (the server remains the source of truth). The mappers trim
 * and, critically, OMIT blank optional fields — the gateway's `optionalString`
 * rejects present-but-empty strings, so a sent `""` would 400. Lat/lng stay
 * strings through the form (z.coerce.number would turn "" into a valid 0) and
 * are converted to numbers only in the mapper.
 */

/** Trimmed non-empty string, or undefined. */
function clean(v?: string): string | undefined {
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

// ── CTA URL interactive ──────────────────────────────────────────────────────

export const ctaUrlSchema = z.object({
  bodyText: z.string().trim().min(1, "Message body is required").max(1024, "At most 1024 characters"),
  headerText: z.string().trim().max(60, "At most 60 characters").optional(),
  footerText: z.string().trim().max(60, "At most 60 characters").optional(),
  ctaDisplayText: z.string().trim().min(1, "Button label is required").max(20, "At most 20 characters"),
  ctaUrl: z
    .string()
    .trim()
    .min(1, "URL is required")
    .max(2048, "At most 2048 characters")
    .regex(/^https?:\/\//i, "Must start with http:// or https://")
});

export type CtaUrlValues = z.infer<typeof ctaUrlSchema>;

export function toCtaUrlBody(v: CtaUrlValues): SendMessageBody {
  const headerText = clean(v.headerText);
  const footerText = clean(v.footerText);
  return {
    kind: "interactive",
    interactive: {
      interactiveType: "cta_url",
      bodyText: v.bodyText.trim(),
      ctaDisplayText: v.ctaDisplayText.trim(),
      ctaUrl: v.ctaUrl.trim(),
      ...(headerText ? { headerText } : {}),
      ...(footerText ? { footerText } : {})
    }
  };
}

// ── Location ─────────────────────────────────────────────────────────────────

function coordinate(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((val) => Number.isFinite(Number(val)), "Must be a number")
    .refine((val) => Math.abs(Number(val)) <= max, `Must be between -${max} and ${max}`);
}

export const locationSchema = z.object({
  latitude: coordinate(90, "Latitude"),
  longitude: coordinate(180, "Longitude"),
  name: z.string().trim().max(200, "At most 200 characters").optional(),
  address: z.string().trim().max(500, "At most 500 characters").optional()
});

export type LocationValues = z.infer<typeof locationSchema>;

export function toLocationBody(v: LocationValues): SendMessageBody {
  const name = clean(v.name);
  const address = clean(v.address);
  return {
    kind: "location",
    location: {
      latitude: Number(v.latitude),
      longitude: Number(v.longitude),
      ...(name ? { name } : {}),
      ...(address ? { address } : {})
    }
  };
}

// ── Contact card (single card) ───────────────────────────────────────────────

export const contactCardSchema = z.object({
  formattedName: z.string().trim().min(1, "Display name is required").max(256, "At most 256 characters"),
  firstName: z.string().trim().max(256, "At most 256 characters").optional(),
  lastName: z.string().trim().max(256, "At most 256 characters").optional(),
  phones: z
    .array(
      z.object({
        phone: z.string().trim().min(1, "Phone is required").max(32, "At most 32 characters"),
        type: z.string().trim().max(32, "At most 32 characters").optional()
      })
    )
    .max(10, "At most 10 phones"),
  emails: z
    .array(
      z.object({
        email: z.string().trim().min(1, "Email is required").max(256, "At most 256 characters"),
        type: z.string().trim().max(32, "At most 32 characters").optional()
      })
    )
    .max(10, "At most 10 emails")
});

export type ContactCardValues = z.infer<typeof contactCardSchema>;

export function toContactsBody(v: ContactCardValues): SendMessageBody {
  const name: WhatsAppContactCard["name"] = { formattedName: v.formattedName.trim() };
  const firstName = clean(v.firstName);
  const lastName = clean(v.lastName);
  if (firstName) name.firstName = firstName;
  if (lastName) name.lastName = lastName;

  const phones = v.phones
    .map((p) => ({ phone: p.phone.trim(), type: clean(p.type) }))
    .filter((p) => p.phone.length > 0)
    .map((p) => (p.type ? { phone: p.phone, type: p.type } : { phone: p.phone }));
  const emails = v.emails
    .map((e) => ({ email: e.email.trim(), type: clean(e.type) }))
    .filter((e) => e.email.length > 0)
    .map((e) => (e.type ? { email: e.email, type: e.type } : { email: e.email }));

  const card: WhatsAppContactCard = { name };
  if (phones.length > 0) card.phones = phones;
  if (emails.length > 0) card.emails = emails;
  return { kind: "contacts", contacts: [card] };
}

// ── Template send (parameters only; name/language come from the chosen row) ───

export const templateParamsSchema = z.object({
  parameters: z.array(z.string().trim().min(1, "Required").max(1024, "At most 1024 characters")).max(50)
});

export type TemplateParamsValues = z.infer<typeof templateParamsSchema>;

export function toTemplateBody(templateName: string, templateLanguage: string, parameters: string[]): SendMessageBody {
  const cleaned = parameters.map((p) => p.trim());
  return {
    kind: "template",
    template: {
      templateName,
      templateLanguage,
      ...(cleaned.length > 0 ? { parameters: cleaned } : {})
    }
  };
}
