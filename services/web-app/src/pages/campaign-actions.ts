import type { Campaign } from "@hyfib/shared-core";

export type CampaignAction = "run" | "pause" | "resume" | "cancel";

/**
 * Mirror of the gateway's transition matrix (api-gateway campaign.ts): run
 * accepts draft; paused campaigns get "resume" (which re-enqueues without
 * re-resolving the segment); cancel reaches every non-terminal status;
 * completed/cancelled are terminal.
 */
export function campaignActions(status: Campaign["status"]): CampaignAction[] {
  switch (status) {
    case "draft":
      return ["run", "cancel"];
    case "scheduled":
      return ["pause", "cancel"];
    case "running":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    default:
      return [];
  }
}
