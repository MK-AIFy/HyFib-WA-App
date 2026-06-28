// Automation rule engine now lives in @hyfib/shared-core so the gateway and
// worker share one implementation. Re-exported here for existing imports/tests.
export {
  evaluateAutomationRules,
  matchesConditions,
  planAction,
  type AutomationTriggerContext,
  type PlannedAction
} from "@hyfib/shared-core";
