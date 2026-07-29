/**
 * Chatbot flow engine core (roadmap G14). A flow is a JSON graph of nodes —
 * exactly what a visual builder edits — executed reactively against inbound
 * messages. This module is PURE: validation and stepping only; the worker owns
 * persistence and side effects, the gateway owns the authoring API.
 *
 * Node types:
 * - message:     send text, continue to `next` (or end when absent)
 * - question:    send text once, then WAIT; the next inbound picks a branch
 *                by case-insensitive exact match, else `fallbackNext`
 *                (else keep waiting silently)
 * - add_tag:     tag the contact, continue
 * - assign_team: hand the conversation to a team (human handoff), continue
 * - end:         terminate the session
 */

export type FlowNode =
  | { type: "message"; text: string; next?: string }
  | {
      type: "question";
      text: string;
      branches: Array<{ match: string; next: string }>;
      fallbackNext?: string;
    }
  | { type: "add_tag"; tag: string; next?: string }
  | { type: "assign_team"; teamId: string; next?: string }
  | { type: "end" };

export interface FlowDefinition {
  start: string;
  nodes: Record<string, FlowNode>;
}

export const FLOW_MAX_NODES = 50;
const MAX_TEXT = 1024;
const MAX_BRANCHES = 10;
/** Bounds a single advance so a mis-authored message cycle cannot spin forever. */
const STEP_CAP = 10;

export type FlowValidation = { ok: true; value: FlowDefinition } | { ok: false; error: string };

export function validateFlowDefinition(value: unknown): FlowValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "definition must be an object with {start, nodes}" };
  }
  const def = value as { start?: unknown; nodes?: unknown };
  if (!def.nodes || typeof def.nodes !== "object" || Array.isArray(def.nodes)) {
    return { ok: false, error: "nodes must be an object keyed by node id" };
  }
  const nodes = def.nodes as Record<string, unknown>;
  const ids = Object.keys(nodes);
  if (ids.length === 0 || ids.length > FLOW_MAX_NODES) {
    return { ok: false, error: `nodes must contain 1 to ${FLOW_MAX_NODES} entries` };
  }
  if (typeof def.start !== "string" || !ids.includes(def.start)) {
    return { ok: false, error: "start must name an existing node" };
  }
  const targetExists = (target: unknown): target is string => typeof target === "string" && ids.includes(target);

  for (const [id, rawNode] of Object.entries(nodes)) {
    const node = rawNode as Record<string, unknown>;
    const fail = (why: string): FlowValidation => ({ ok: false, error: `node "${id}": ${why}` });
    switch (node.type) {
      case "message": {
        if (typeof node.text !== "string" || node.text.trim().length === 0 || node.text.length > MAX_TEXT) {
          return fail(`text must be a non-empty string of at most ${MAX_TEXT} characters`);
        }
        if (node.next !== undefined && !targetExists(node.next)) {
          return fail(`next "${String(node.next)}" does not exist`);
        }
        break;
      }
      case "question": {
        if (typeof node.text !== "string" || node.text.trim().length === 0 || node.text.length > MAX_TEXT) {
          return fail(`text must be a non-empty string of at most ${MAX_TEXT} characters`);
        }
        if (!Array.isArray(node.branches) || node.branches.length === 0 || node.branches.length > MAX_BRANCHES) {
          return fail(`branches must contain 1 to ${MAX_BRANCHES} entries`);
        }
        for (const branch of node.branches as Array<Record<string, unknown>>) {
          if (typeof branch.match !== "string" || branch.match.trim().length === 0 || branch.match.length > 100) {
            return fail("every branch needs a non-empty match of at most 100 characters");
          }
          if (!targetExists(branch.next)) {
            return fail(`branch target "${String(branch.next)}" does not exist`);
          }
        }
        if (node.fallbackNext !== undefined && !targetExists(node.fallbackNext)) {
          return fail(`fallbackNext "${String(node.fallbackNext)}" does not exist`);
        }
        break;
      }
      case "add_tag": {
        if (typeof node.tag !== "string" || node.tag.trim().length === 0 || node.tag.length > 100) {
          return fail("tag must be a non-empty string of at most 100 characters");
        }
        if (node.next !== undefined && !targetExists(node.next)) {
          return fail(`next "${String(node.next)}" does not exist`);
        }
        break;
      }
      case "assign_team": {
        if (typeof node.teamId !== "string" || !/^[0-9a-f-]{36}$/i.test(node.teamId)) {
          return fail("teamId must be a team UUID");
        }
        if (node.next !== undefined && !targetExists(node.next)) {
          return fail(`next "${String(node.next)}" does not exist`);
        }
        break;
      }
      case "end":
        break;
      default:
        return fail(`unknown type "${String(node.type)}"`);
    }
  }
  return { ok: true, value: value as FlowDefinition };
}

export type FlowAction =
  | { type: "send"; text: string }
  | { type: "add_tag"; tag: string }
  | { type: "assign_team"; teamId: string };

export type FlowOutcome = { status: "waiting"; node: string } | { status: "done" };

export interface FlowAdvanceResult {
  actions: FlowAction[];
  outcome: FlowOutcome;
}

/**
 * Advances a session. `inboundText` is the customer's reply when the session
 * is waiting at a question (null when starting a fresh session). Runs through
 * non-waiting nodes until it must wait or the flow ends; STEP_CAP bounds
 * mis-authored cycles.
 */
export function advanceFlow(
  definition: FlowDefinition,
  currentNode: string,
  inboundText: string | null
): FlowAdvanceResult {
  const actions: FlowAction[] = [];
  let cursor: string | undefined = currentNode;
  let reply = inboundText;

  for (let step = 0; step < STEP_CAP && cursor; step += 1) {
    const node: FlowNode | undefined = definition.nodes[cursor];
    if (!node) {
      return { actions, outcome: { status: "done" } };
    }
    switch (node.type) {
      case "message":
        actions.push({ type: "send", text: node.text });
        cursor = node.next;
        break;
      case "add_tag":
        actions.push({ type: "add_tag", tag: node.tag });
        cursor = node.next;
        break;
      case "assign_team":
        actions.push({ type: "assign_team", teamId: node.teamId });
        cursor = node.next;
        break;
      case "end":
        return { actions, outcome: { status: "done" } };
      case "question": {
        if (reply === null) {
          // Arriving at the question: ask it and wait for the customer.
          actions.push({ type: "send", text: node.text });
          return { actions, outcome: { status: "waiting", node: cursor } };
        }
        const normalized = reply.trim().toLowerCase();
        reply = null; // a reply is consumed by exactly one question
        const branch = node.branches.find(
          (candidate: { match: string; next: string }) => candidate.match.trim().toLowerCase() === normalized
        );
        if (branch) {
          cursor = branch.next;
        } else if (node.fallbackNext) {
          cursor = node.fallbackNext;
        } else {
          return { actions, outcome: { status: "waiting", node: cursor } };
        }
        break;
      }
    }
  }
  return { actions, outcome: { status: "done" } };
}
