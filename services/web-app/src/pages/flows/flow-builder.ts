import type { FlowDefinition, FlowNode } from "@hyfib/shared-core";

/**
 * Editor-state → FlowDefinition serialization for the form-based flow builder
 * (roadmap G14 UI). The server re-validates with the engine's
 * validateFlowDefinition; this mirrors the rules that matter for authoring UX
 * so mistakes surface before submit.
 */

export interface BranchDraft {
  match: string;
  next: string;
}

export interface NodeDraft {
  id: string;
  type: "message" | "question" | "add_tag" | "assign_team" | "end";
  text?: string;
  tag?: string;
  teamId?: string;
  /** Empty string = flow ends after this node. */
  next?: string;
  branches?: BranchDraft[];
  fallbackNext?: string;
}

export type BuildResult = { ok: true; value: FlowDefinition } | { ok: false; error: string };

export function buildDefinition(startId: string, drafts: NodeDraft[]): BuildResult {
  if (drafts.length === 0) {
    return { ok: false, error: "Add at least one step" };
  }
  const ids = drafts.map((d) => d.id.trim());
  if (ids.some((id) => id.length === 0)) {
    return { ok: false, error: "Every step needs an id" };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "Step ids must be unique" };
  }
  if (!ids.includes(startId)) {
    return { ok: false, error: "Pick a start step" };
  }
  const exists = (target: string): boolean => ids.includes(target);
  const nodes: Record<string, FlowNode> = {};

  for (const draft of drafts) {
    const id = draft.id.trim();
    const next = draft.next?.trim() || undefined;
    if (next && !exists(next)) {
      return { ok: false, error: `Step "${id}": next step "${next}" does not exist` };
    }
    switch (draft.type) {
      case "message": {
        if (!draft.text?.trim()) {
          return { ok: false, error: `Step "${id}": message text is required` };
        }
        nodes[id] = { type: "message", text: draft.text.trim(), ...(next ? { next } : {}) };
        break;
      }
      case "question": {
        if (!draft.text?.trim()) {
          return { ok: false, error: `Step "${id}": question text is required` };
        }
        const branches = (draft.branches ?? []).filter((b) => b.match.trim().length > 0);
        if (branches.length === 0) {
          return { ok: false, error: `Step "${id}": add at least one reply branch` };
        }
        for (const branch of branches) {
          if (!branch.next || !exists(branch.next)) {
            return { ok: false, error: `Step "${id}": branch "${branch.match}" needs an existing target step` };
          }
        }
        const fallbackNext = draft.fallbackNext?.trim() || undefined;
        if (fallbackNext && !exists(fallbackNext)) {
          return { ok: false, error: `Step "${id}": fallback step "${fallbackNext}" does not exist` };
        }
        nodes[id] = {
          type: "question",
          text: draft.text.trim(),
          branches: branches.map((b) => ({ match: b.match.trim(), next: b.next })),
          ...(fallbackNext ? { fallbackNext } : {})
        };
        break;
      }
      case "add_tag": {
        if (!draft.tag?.trim()) {
          return { ok: false, error: `Step "${id}": tag is required` };
        }
        nodes[id] = { type: "add_tag", tag: draft.tag.trim(), ...(next ? { next } : {}) };
        break;
      }
      case "assign_team": {
        if (!draft.teamId) {
          return { ok: false, error: `Step "${id}": pick a team for the handoff` };
        }
        nodes[id] = { type: "assign_team", teamId: draft.teamId, ...(next ? { next } : {}) };
        break;
      }
      case "end": {
        nodes[id] = { type: "end" };
        break;
      }
    }
  }
  return { ok: true, value: { start: startId, nodes } };
}

let counter = 0;
/** Sequential, human-readable step ids for new drafts. */
export function nextNodeId(existing: NodeDraft[]): string {
  counter += 1;
  let candidate = `step${counter}`;
  while (existing.some((d) => d.id === candidate)) {
    counter += 1;
    candidate = `step${counter}`;
  }
  return candidate;
}
