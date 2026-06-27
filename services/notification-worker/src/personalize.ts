import type { VariableMapping } from "@hyfib/shared-core";

export interface ContactSnapshot {
  firstName?: string;
  lastName?: string;
  phoneE164: string;
  country?: string;
  tags: string[];
  timezone?: string;
}

const CONTACT_FIELD_MAP: Record<string, keyof ContactSnapshot> = {
  firstname: "firstName",
  first_name: "firstName",
  lastname: "lastName",
  last_name: "lastName",
  phone: "phoneE164",
  phone_e164: "phoneE164",
  country: "country",
  timezone: "timezone"
};

/**
 * Resolves template positional parameters from a variable mapping and a contact.
 * Keys are 1-based string indices ("1", "2", …).
 * Values are contact field names or { literal: "..." } objects.
 *
 * Returns an ordered array of strings for parameters[0..n].
 * Falls back to empty strings for unresolved positions.
 *
 * Pure function — no I/O, fully unit-testable.
 */
export function resolveVariables(mapping: VariableMapping | undefined, contact: ContactSnapshot): string[] {
  if (!mapping || Object.keys(mapping).length === 0) {
    return [];
  }
  const maxIndex = Math.max(...Object.keys(mapping).map(Number).filter(Number.isFinite));
  const result: string[] = [];
  for (let i = 1; i <= maxIndex; i++) {
    const spec = mapping[String(i)];
    if (spec === undefined) {
      result.push("");
      continue;
    }
    if (typeof spec === "object" && "literal" in spec) {
      result.push(spec.literal);
      continue;
    }
    const field = CONTACT_FIELD_MAP[spec.toLowerCase()] ?? (spec as keyof ContactSnapshot);
    const value = contact[field];
    result.push(Array.isArray(value) ? value.join(", ") : (value ?? ""));
  }
  return result;
}
