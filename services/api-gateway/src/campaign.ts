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
