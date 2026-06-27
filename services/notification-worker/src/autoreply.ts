import type { AutoReplyRule } from "@hyfib/shared-core";

/**
 * Finds the first enabled rule that matches the given message text.
 * Rules are evaluated highest-priority first.
 * Returns the matching rule or undefined if none matched.
 *
 * Pure function — no I/O.
 */
export function matchAutoReply(text: string | undefined, rules: AutoReplyRule[]): AutoReplyRule | undefined {
  if (!text || rules.length === 0) return undefined;
  const normalised = text.trim().toLowerCase();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    switch (rule.matchType) {
      case "any":
        return rule;
      case "keyword":
        if (rule.keyword && normalised === rule.keyword.trim().toLowerCase()) return rule;
        break;
      case "contains":
        if (rule.keyword && normalised.includes(rule.keyword.trim().toLowerCase())) return rule;
        break;
      case "regex":
        try {
          if (rule.keyword && new RegExp(rule.keyword, "i").test(normalised)) return rule;
        } catch {
          // Invalid regex: skip rule.
        }
        break;
    }
  }
  return undefined;
}
