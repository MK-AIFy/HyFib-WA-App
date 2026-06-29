/**
 * Minimal CSV parser with no dependencies.
 * Handles quoted fields, escaped quotes (""), CRLF and LF line endings.
 */

export interface ParsedCsvRow {
  phoneE164?: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  timezone?: string;
  tags?: string[];
  consent?: boolean;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  return fields;
}

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const MAX_CSV_ROWS = 50_000;
const MAX_TAG_LENGTH = 100;

/**
 * Parses CSV bytes into structured contact rows.
 * Expected header (case-insensitive, order flexible):
 *   phone_e164, first_name, last_name, country, timezone, tags, consent
 *
 * Returns { rows, errors } — errors are per-line validation messages.
 */
export function parseCsv(buffer: Buffer): { rows: ParsedCsvRow[]; errors: string[] } {
  const text = buffer.toString("utf-8");
  const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    return { rows: [], errors: ["CSV is empty"] };
  }

  const headerLine = rawLines[0]!;
  const headers = parseCsvLine(headerLine).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const idx = (name: string) => headers.indexOf(name);
  const phoneIdx = idx("phone_e164") !== -1 ? idx("phone_e164") : idx("phone");
  const firstIdx = idx("first_name") !== -1 ? idx("first_name") : idx("firstname");
  const lastIdx = idx("last_name") !== -1 ? idx("last_name") : idx("lastname");
  const countryIdx = idx("country");
  const tzIdx = idx("timezone");
  const tagsIdx = idx("tags");
  const consentIdx = idx("consent");

  if (phoneIdx === -1) {
    return { rows: [], errors: ['CSV must have a "phone_e164" or "phone" column'] };
  }

  const E164 = /^\+[1-9]\d{7,14}$/;
  const rows: ParsedCsvRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < rawLines.length; i++) {
    if (rows.length >= MAX_CSV_ROWS) {
      errors.push(`Import truncated at ${MAX_CSV_ROWS} rows; subsequent rows were ignored`);
      break;
    }
    const fields = parseCsvLine(rawLines[i]!);
    const phone = fields[phoneIdx]?.trim();
    if (!phone) {
      errors.push(`Row ${i + 1}: phone is empty, skipped`);
      continue;
    }
    if (!E164.test(phone)) {
      errors.push(`Row ${i + 1}: "${phone}" is not a valid E.164 number, skipped`);
      continue;
    }
    const tagsRaw = tagsIdx !== -1 ? fields[tagsIdx]?.trim() : undefined;
    const tags = tagsRaw
      ? tagsRaw
          .split("|")
          .map((t) => t.trim().slice(0, MAX_TAG_LENGTH))
          .filter(Boolean)
      : [];
    const consentRaw = consentIdx !== -1 ? fields[consentIdx]?.trim().toLowerCase() : undefined;
    rows.push({
      phoneE164: phone,
      firstName: firstIdx !== -1 ? fields[firstIdx]?.trim() || undefined : undefined,
      lastName: lastIdx !== -1 ? fields[lastIdx]?.trim() || undefined : undefined,
      country: countryIdx !== -1 ? fields[countryIdx]?.trim() || undefined : undefined,
      timezone: tzIdx !== -1 ? fields[tzIdx]?.trim() || undefined : undefined,
      tags: tags.length > 0 ? tags : undefined,
      consent: consentRaw !== undefined ? TRUTHY.has(consentRaw) : undefined
    });
  }

  return { rows, errors };
}

/** Escapes a value for CSV output, quoting when it contains a delimiter/quote/newline. */
function csvCell(value: string | undefined): string {
  const s = value ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportableContact {
  phoneE164: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  timezone?: string;
  tags: string[];
  optedOut: boolean;
}

/** Serializes contacts to the same column shape the importer accepts. */
export function serializeContactsCsv(contacts: readonly ExportableContact[]): string {
  const header = "phone_e164,first_name,last_name,country,timezone,tags,consent";
  const lines = contacts.map((c) =>
    [
      csvCell(c.phoneE164),
      csvCell(c.firstName),
      csvCell(c.lastName),
      csvCell(c.country),
      csvCell(c.timezone),
      csvCell((c.tags ?? []).join("|")),
      c.optedOut ? "false" : "true"
    ].join(",")
  );
  return [header, ...lines].join("\n");
}

/**
 * Extracts the first file body from a multipart/form-data buffer.
 * Returns the extracted bytes, or null if the buffer is not valid multipart.
 */
export function extractMultipartFile(buffer: Buffer, boundary: string): Buffer | null {
  try {
    const sep = Buffer.from(`--${boundary}`);
    const partStart = buffer.indexOf(sep);
    if (partStart === -1) return null;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd === -1) return null;
    const fileStart = headerEnd + 4;
    const closing = Buffer.from(`\r\n--${boundary}`);
    const fileEnd = buffer.indexOf(closing, fileStart);
    return fileEnd === -1
      ? buffer.subarray(fileStart)
      : buffer.subarray(fileStart, fileEnd);
  } catch {
    return null;
  }
}
