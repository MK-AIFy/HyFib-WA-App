import type { AutomationRule, AutomationTriggerType } from "./index.js";

export interface AutomationTriggerContext {
  /** Inbound message text (new_message trigger). */
  messageText?: string;
  /** Tag just added (tag_added trigger). */
  addedTag?: string;
}

export type PlannedAction =
  | { kind: "send_template"; templateName: string; templateLanguage: string }
  | { kind: "assign_agent"; assigneeUserId: string }
  | { kind: "add_tag"; tag: string }
  | { kind: "create_task"; title: string; dueInMinutes?: number };

/** True when a rule's conditions match the trigger context. Pure. */
export function matchesConditions(rule: AutomationRule, ctx: AutomationTriggerContext): boolean {
  const { keyword, tag } = rule.conditions;
  if (rule.triggerType === "new_message" && keyword) {
    const text = (ctx.messageText ?? "").toLowerCase();
    if (!text.includes(keyword.toLowerCase())) {
      return false;
    }
  }
  if (rule.triggerType === "tag_added" && tag) {
    if ((ctx.addedTag ?? "").toLowerCase() !== tag.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/** Maps a matched rule's action to a concrete planned action, or undefined if misconfigured. */
export function planAction(rule: AutomationRule): PlannedAction | undefined {
  const cfg = rule.actionConfig;
  switch (rule.actionType) {
    case "send_template":
      if (!cfg.templateName) return undefined;
      return {
        kind: "send_template",
        templateName: cfg.templateName,
        templateLanguage: cfg.templateLanguage ?? "en_US"
      };
    case "assign_agent":
      if (!cfg.assigneeUserId) return undefined;
      return { kind: "assign_agent", assigneeUserId: cfg.assigneeUserId };
    case "add_tag":
      if (!cfg.tag) return undefined;
      return { kind: "add_tag", tag: cfg.tag };
    case "create_task":
      return { kind: "create_task", title: cfg.taskTitle ?? "Follow up", dueInMinutes: cfg.dueInMinutes };
    default:
      return undefined;
  }
}

/**
 * Evaluates enabled rules for a trigger and returns the planned actions in
 * priority order. Pure (no I/O) so it is fully unit-testable.
 */
export function evaluateAutomationRules(
  triggerType: AutomationTriggerType,
  ctx: AutomationTriggerContext,
  rules: readonly AutomationRule[]
): PlannedAction[] {
  const actions: PlannedAction[] = [];
  for (const rule of rules) {
    if (rule.triggerType !== triggerType || !rule.enabled) {
      continue;
    }
    if (!matchesConditions(rule, ctx)) {
      continue;
    }
    const action = planAction(rule);
    if (action) {
      actions.push(action);
    }
  }
  return actions;
}
