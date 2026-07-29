import { createServer } from "node:http";
import { argv } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@hyfib/config";
import {
  Logger,
  notFound,
  parseUrlPath,
  readRawBody,
  redactPII,
  requestContext,
  sendJson,
  sendMetrics
} from "@hyfib/shared-core";

interface DraftCampaignRequest {
  objective: string;
  audienceDescription: string;
  offer: string;
  tone: "professional" | "friendly" | "urgent";
  language: string;
}

interface SegmentSummaryRequest {
  segmentName: string;
  contacts: number;
  conversionRate: number;
  optOutRate: number;
}

interface LeadScoreRequest {
  recencyDays: number;
  engagementScore: number;
  purchaseCount: number;
  averageOrderValue: number;
}

const config = loadConfig();
const logger = new Logger("ai-intelligence-service", config.logLevel as "debug" | "info" | "warn" | "error");

async function callClaude(system: string, user: string): Promise<string> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: config.anthropicMaxTokens,
      system,
      messages: [
        {
          role: "user",
          content: user
        }
      ]
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 1200);
    throw new Error(`Claude request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };

  const text = data.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Claude returned empty response");
  }
  return text;
}

function fallbackCampaignDraft(input: DraftCampaignRequest): string {
  return [
    `Objective: ${input.objective}`,
    `Audience: ${input.audienceDescription}`,
    `Offer: ${input.offer}`,
    `Tone: ${input.tone}, Language: ${input.language}`,
    "Message Draft:",
    `Hello! We selected this for you: ${input.offer}. Reply YES to learn more or STOP to opt out.`
  ].join("\n");
}

function fallbackSegmentSummary(input: SegmentSummaryRequest): string {
  const risk = input.optOutRate > 0.03 ? "high" : input.optOutRate > 0.015 ? "moderate" : "low";
  return `Segment ${input.segmentName} has ${input.contacts} contacts, conversion ${input.conversionRate}% and opt-out ${input.optOutRate}%. Risk is ${risk}; apply cautious frequency caps.`;
}

function fallbackLeadScore(input: LeadScoreRequest): number {
  const recencyFactor = Math.max(0, 100 - input.recencyDays * 2);
  const purchaseFactor = Math.min(100, input.purchaseCount * 12);
  const valueFactor = Math.min(100, input.averageOrderValue / 100);
  const raw = recencyFactor * 0.35 + input.engagementScore * 0.35 + purchaseFactor * 0.2 + valueFactor * 0.1;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

async function runWithFallback(
  system: string,
  user: string,
  fallback: string
): Promise<{ text: string; mode: "claude" | "fallback" }> {
  try {
    const text = await callClaude(system, redactPII(user));
    return { text, mode: "claude" };
  } catch (error) {
    logger.warn("claude_unavailable_using_fallback", {
      error: error instanceof Error ? error.message : String(error)
    });

    if (!config.aiDeterministicFallback) {
      throw error;
    }

    return { text: fallback, mode: "fallback" };
  }
}

function safeParse<T>(raw: string | undefined): T {
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    return {} as T;
  }
}

// ─── Inbox copilot (roadmap G15): summary + suggested replies ──────────────────

interface CopilotMessage {
  direction: "inbound" | "outbound";
  text: string;
}

const COPILOT_MAX_MESSAGES = 50;
const COPILOT_MAX_MESSAGE_CHARS = 1000;
const COPILOT_MAX_TOTAL_CHARS = 15_000;

/** Validates and bounds a copilot transcript; undefined = reject with 400. */
export function normalizeCopilotMessages(raw: unknown): CopilotMessage[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > COPILOT_MAX_MESSAGES) {
    return undefined;
  }
  const messages: CopilotMessage[] = [];
  let total = 0;
  for (const entry of raw) {
    const item = entry as { direction?: unknown; text?: unknown };
    if (item.direction !== "inbound" && item.direction !== "outbound") {
      return undefined;
    }
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      continue; // media/interactive rows without text are simply omitted
    }
    const text = item.text.trim().slice(0, COPILOT_MAX_MESSAGE_CHARS);
    total += text.length;
    if (total > COPILOT_MAX_TOTAL_CHARS) {
      break;
    }
    messages.push({ direction: item.direction, text });
  }
  return messages.length > 0 ? messages : undefined;
}

function copilotTranscript(messages: CopilotMessage[]): string {
  return messages.map((m) => `${m.direction === "inbound" ? "Customer" : "Agent"}: ${m.text}`).join("\n");
}

function fallbackConversationSummary(messages: CopilotMessage[]): string {
  const inbound = messages.filter((m) => m.direction === "inbound");
  const lastCustomer = inbound[inbound.length - 1]?.text ?? "(no customer message)";
  return `Conversation with ${messages.length} recent messages (${inbound.length} from the customer). Latest customer message: "${lastCustomer.slice(0, 200)}"`;
}

const FALLBACK_SUGGESTIONS = [
  "Thanks for reaching out! Let me look into that for you right away.",
  "Could you share a few more details so I can help you faster?",
  "I've noted your request and will get back to you shortly with an update."
];

/** Parses "1. …\n2. …" style output into up to three suggestions. */
export function parseSuggestions(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter((line) => line.length > 0);
  const suggestions = lines.slice(0, 3).map((line) => line.slice(0, 300));
  return suggestions.length > 0 ? suggestions : [text.trim().slice(0, 300)];
}

/**
 * Route an `/internal/v1/ai/*` request to the matching handler, returning the
 * status + body the HTTP endpoint produces. Exported so app-server calls it
 * directly in-process (the gateway forwards the raw JSON body).
 */
export async function dispatchAi(
  aiPath: string,
  method: string,
  rawBody: string | undefined,
  requestId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  if (aiPath === "conversation-summary") {
    const payload = safeParse<{ messages?: unknown }>(rawBody);
    const messages = normalizeCopilotMessages(payload.messages);
    if (!messages) {
      return {
        status: 400,
        body: { error: "messages must be a non-empty array (max 50) of {direction: inbound|outbound, text}" }
      };
    }
    const system =
      "You summarize WhatsApp customer conversations for support agents. Be factual, concise and neutral. " +
      "Output 2-4 sentences covering the customer's need, the current status, and any commitments made. " +
      "Never invent details that are not in the transcript.";
    const result = await runWithFallback(system, copilotTranscript(messages), fallbackConversationSummary(messages));
    return { status: 200, body: { requestId, mode: result.mode, summary: result.text } };
  }

  if (aiPath === "suggest-reply") {
    const payload = safeParse<{ messages?: unknown }>(rawBody);
    const messages = normalizeCopilotMessages(payload.messages);
    if (!messages) {
      return {
        status: 400,
        body: { error: "messages must be a non-empty array (max 50) of {direction: inbound|outbound, text}" }
      };
    }
    const system =
      "You draft the support agent's next WhatsApp reply. Output EXACTLY three numbered suggestions, " +
      "each under 300 characters, in the conversation's language. Never invent order details, prices, " +
      "or commitments that are not present in the transcript.";
    const result = await runWithFallback(system, copilotTranscript(messages), FALLBACK_SUGGESTIONS.join("\n"));
    return {
      status: 200,
      body: { requestId, mode: result.mode, suggestions: parseSuggestions(result.text) }
    };
  }

  if (aiPath === "campaign-draft") {
    const payload = safeParse<DraftCampaignRequest>(rawBody);
    const VALID_TONES = ["professional", "friendly", "urgent"] as const;
    if (!payload.objective || !payload.audienceDescription || !payload.offer || !payload.tone || !payload.language) {
      return { status: 400, body: { error: "objective, audienceDescription, offer, tone and language are required" } };
    }
    if (!VALID_TONES.includes(payload.tone as (typeof VALID_TONES)[number])) {
      return { status: 400, body: { error: `tone must be one of: ${VALID_TONES.join(", ")}` } };
    }
    if (
      String(payload.objective).length > 500 ||
      String(payload.audienceDescription).length > 500 ||
      String(payload.offer).length > 500 ||
      String(payload.language).length > 50
    ) {
      return {
        status: 400,
        body: { error: "objective, audienceDescription, offer must be ≤500 chars; language ≤50 chars" }
      };
    }
    const system =
      "You are a B2B WhatsApp marketing assistant. Output policy-safe campaign drafts only. Never bypass consent or template policy.";
    const user = `Create a concise campaign draft. Objective: ${payload.objective}. Audience: ${payload.audienceDescription}. Offer: ${payload.offer}. Tone: ${payload.tone}. Language: ${payload.language}. Include a clear opt-out reminder.`;
    const result = await runWithFallback(system, user, fallbackCampaignDraft(payload));
    return { status: 200, body: { requestId, mode: result.mode, draft: result.text } };
  }

  if (aiPath === "segment-summary") {
    const payload = safeParse<SegmentSummaryRequest>(rawBody);
    if (!payload.segmentName || typeof payload.contacts !== "number" || payload.contacts <= 0) {
      return { status: 400, body: { error: "segmentName and contacts (>0) are required" } };
    }
    if (String(payload.segmentName).length > 200) {
      return { status: 400, body: { error: "segmentName must be ≤200 chars" } };
    }
    const cr = Number(payload.conversionRate);
    const oor = Number(payload.optOutRate);
    if (!Number.isFinite(cr) || cr < 0 || cr > 100 || !Number.isFinite(oor) || oor < 0 || oor > 1) {
      return { status: 400, body: { error: "conversionRate must be 0-100; optOutRate must be 0-1" } };
    }
    const system = "You summarize marketing segment quality and operational risk for internal analysts.";
    const user = `Summarize segment ${payload.segmentName} with contacts=${payload.contacts}, conversionRate=${payload.conversionRate}, optOutRate=${payload.optOutRate}. Output max 5 bullet points.`;
    const result = await runWithFallback(system, user, fallbackSegmentSummary(payload));
    return { status: 200, body: { requestId, mode: result.mode, summary: result.text } };
  }

  if (aiPath === "lead-score") {
    const payload = safeParse<LeadScoreRequest>(rawBody);
    const rd = Number(payload.recencyDays);
    const es = Number(payload.engagementScore);
    const pc = Number(payload.purchaseCount);
    const aov = Number(payload.averageOrderValue);
    if (
      !Number.isFinite(rd) ||
      rd < 0 ||
      rd > 3650 ||
      !Number.isFinite(es) ||
      es < 0 ||
      es > 100 ||
      !Number.isFinite(pc) ||
      pc < 0 ||
      !Number.isFinite(aov) ||
      aov < 0
    ) {
      return {
        status: 400,
        body: { error: "recencyDays 0-3650, engagementScore 0-100, purchaseCount ≥0, averageOrderValue ≥0 required" }
      };
    }
    const score = fallbackLeadScore(payload);
    return {
      status: 200,
      body: {
        requestId,
        score,
        scale: "0-100",
        recommendation:
          score >= 75
            ? "Prioritize for marketing follow-up"
            : score >= 45
              ? "Nurture with informational template"
              : "Low priority; suppress from high-frequency campaigns"
      }
    };
  }

  return { status: 404, body: { error: "route_not_found" } };
}

const server = createServer(async (req, res) => {
  try {
    const path = parseUrlPath(req.url);
    const method = req.method ?? "GET";
    const ctx = requestContext(req);

    if (path === "/metrics") {
      sendMetrics(res);
      return;
    }

    if (path.startsWith("/internal/")) {
      const providedSecret =
        typeof req.headers["x-internal-secret"] === "string" ? req.headers["x-internal-secret"] : "";
      if (config.internalServiceSecret !== "" && providedSecret !== config.internalServiceSecret) {
        logger.warn("internal_auth_failed", { requestId: ctx.requestId, path });
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    if (path === "/health") {
      sendJson(res, 200, {
        service: "ai-intelligence-service",
        status: "ok",
        model: config.anthropicModel,
        deterministicFallback: config.aiDeterministicFallback,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (path.startsWith("/internal/v1/ai/")) {
      const aiPath = path.slice("/internal/v1/ai/".length);
      const raw = await readRawBody(req);
      const { status, body } = await dispatchAi(aiPath, method, raw, ctx.requestId);
      sendJson(res, status, body);
      return;
    }

    notFound(res);
  } catch (error) {
    logger.error("request_handler_error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_server_error" });
    }
  }
});

// Boot the standalone service only when executed directly, never when imported
// by app-server for its exported dispatchAi function.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(config.aiIntelligencePort, () => {
    logger.info("service_started", {
      port: config.aiIntelligencePort,
      nodeEnv: config.nodeEnv
    });
  });

  server.on("error", (error) => {
    logger.error("service_error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}
