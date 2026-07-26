export interface SendableContact {
  id: string;
  phoneE164: string;
  optedOut?: boolean;
}

export interface SendableSplit<T extends SendableContact> {
  eligible: T[];
  suppressed: number;
}

/**
 * Final pre-send safeguard for bulk campaigns: drops any opted-out contact so
 * they can never be queued, regardless of how the audience was resolved.
 * Returns the eligible recipients plus the suppressed count for operator
 * visibility/audit. Pure (no I/O) so it is unit-testable.
 */
export function filterSendableContacts<T extends SendableContact>(contacts: readonly T[]): SendableSplit<T> {
  const eligible = contacts.filter((contact) => !contact.optedOut);
  return { eligible, suppressed: contacts.length - eligible.length };
}

export type CampaignAction = "pause" | "resume" | "cancel";

/**
 * The campaign status transitions this service performs, and the only statuses
 * each is legal from. Declared once here rather than as magic literals in the
 * router: the same set is needed by the route's read-side pre-check (for a good
 * 409 message) and by the guarded UPDATE (for race safety), and those two
 * drifting apart is exactly how a status machine rots.
 *
 * Pausing a 'scheduled' campaign de-schedules it for free — due_scheduled_campaigns
 * filters status='scheduled' — and scheduled_at survives, since only the
 * scheduler's own claim NULLs it. Resume therefore returns to 'running', not
 * 'scheduled': a resumed campaign runs now rather than waiting on a time that
 * has most likely already passed.
 *
 * Pure (no I/O) so it is unit-testable, like filterSendableContacts above.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignAction, { from: readonly string[]; to: string }> = {
  pause: { from: ["running", "scheduled"], to: "paused" },
  resume: { from: ["paused"], to: "running" },
  // Cancel is terminal and deliberately reaches every non-terminal status,
  // including 'draft' — abandoning a campaign that was never started is a
  // legitimate operator action. Nothing transitions out of 'cancelled': it is
  // absent from every `from` set above, and runCampaign's own allowed-from is
  // ('draft','paused'), so /run cannot revive one either.
  //
  // 'completed' is excluded on purpose. Cancelling a campaign that already
  // finished would rewrite history to say it was stopped, which is precisely
  // the kind of thing a compliance audit must be able to trust.
  cancel: { from: ["draft", "scheduled", "running", "paused"], to: "cancelled" }
};

/**
 * True when `action` may be applied to a campaign currently in `current`.
 *
 * Takes a plain string rather than Campaign["status"] on purpose: the DB column
 * is untyped TEXT and repositories.ts widens it with an unchecked cast, so an
 * out-of-union value can reach here. Such a value is simply not transitionable.
 */
export function canTransition(current: string, action: CampaignAction): boolean {
  return CAMPAIGN_TRANSITIONS[action].from.includes(current);
}

/** Operator-facing 409 message, phrased like the existing guard in runCampaign. */
export function transitionConflict(current: string, action: CampaignAction): string {
  const from = CAMPAIGN_TRANSITIONS[action].from;
  const last = from[from.length - 1] ?? "";
  const legal = from.length > 1 ? `${from.slice(0, -1).join(", ")} or ${last}` : last;
  return `Cannot ${action} a campaign that is ${current}; it must be ${legal}`;
}
