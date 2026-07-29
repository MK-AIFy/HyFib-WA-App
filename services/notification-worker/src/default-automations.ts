import { isWithinWorkingHours, type AutomationSettings } from "@hyfib/shared-core";

/**
 * Pure decision for the default automations (roadmap G8). Precedence: an
 * out-of-office reply wins over a welcome — out of hours the recipient is
 * told nobody is around; a welcome would imply the opposite. OOO only fires
 * when working hours are actually configured (an empty weekly map means the
 * feature is unused, and isWithinWorkingHours is always true), so toggling
 * ooo_enabled alone can never spam every inbound around the clock.
 */
export type DefaultAutomationDecision = { kind: "ooo" | "welcome"; text: string } | undefined;

export function decideDefaultAutomation(input: {
  settings:
    | Pick<
        AutomationSettings,
        "timezone" | "workingHours" | "welcomeEnabled" | "welcomeText" | "oooEnabled" | "oooText"
      >
    | undefined;
  firstInbound: boolean;
  now: Date;
}): DefaultAutomationDecision {
  const settings = input.settings;
  if (!settings) {
    return undefined;
  }
  const hours = settings.workingHours ?? {};
  const hoursConfigured = Object.keys(hours).length > 0;
  if (
    settings.oooEnabled &&
    settings.oooText?.trim() &&
    hoursConfigured &&
    !isWithinWorkingHours(hours, settings.timezone, input.now)
  ) {
    return { kind: "ooo", text: settings.oooText.trim() };
  }
  if (settings.welcomeEnabled && settings.welcomeText?.trim() && input.firstInbound) {
    return { kind: "welcome", text: settings.welcomeText.trim() };
  }
  return undefined;
}
