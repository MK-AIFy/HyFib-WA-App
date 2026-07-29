/**
 * Validation for the drip-sequence API (roadmap G7). Pure module so it is
 * unit-testable without booting the gateway.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SEQUENCE_STEPS = 20;

export interface SequenceCreateValue {
  name: string;
  channelId: string;
  stopOnReply: boolean;
  steps: Array<{ delayMinutes: number; templateId: string }>;
}

export type SequenceCreateResult = { ok: true; value: SequenceCreateValue } | { ok: false; error: string };

export function validateSequenceCreate(payload: unknown): SequenceCreateResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = payload as { name?: unknown; channelId?: unknown; stopOnReply?: unknown; steps?: unknown };
  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > 200) {
    return { ok: false, error: "name must be a non-empty string of at most 200 characters" };
  }
  if (typeof raw.channelId !== "string" || !UUID_RE.test(raw.channelId)) {
    return { ok: false, error: "channelId must be a channel UUID" };
  }
  if (raw.stopOnReply !== undefined && typeof raw.stopOnReply !== "boolean") {
    return { ok: false, error: "stopOnReply must be a boolean" };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_SEQUENCE_STEPS) {
    return { ok: false, error: `steps must be an array of 1 to ${MAX_SEQUENCE_STEPS} steps` };
  }
  const steps: Array<{ delayMinutes: number; templateId: string }> = [];
  for (const [index, step] of raw.steps.entries()) {
    const s = step as { delayMinutes?: unknown; templateId?: unknown };
    if (
      typeof s.delayMinutes !== "number" ||
      !Number.isInteger(s.delayMinutes) ||
      s.delayMinutes < 0 ||
      s.delayMinutes > 525_600
    ) {
      return { ok: false, error: `steps[${index}].delayMinutes must be an integer between 0 and 525600` };
    }
    if (typeof s.templateId !== "string" || !UUID_RE.test(s.templateId)) {
      return { ok: false, error: `steps[${index}].templateId must be a template UUID` };
    }
    steps.push({ delayMinutes: s.delayMinutes, templateId: s.templateId });
  }
  return {
    ok: true,
    value: {
      name: (raw.name as string).trim(),
      channelId: raw.channelId as string,
      stopOnReply: (raw.stopOnReply as boolean | undefined) ?? true,
      steps
    }
  };
}
