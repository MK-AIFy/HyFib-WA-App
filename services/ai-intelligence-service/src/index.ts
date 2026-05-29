import { createServer } from "node:http";
import { loadConfig } from "@hyfib/config";
import {
  Logger,
  methodNotAllowed,
  notFound,
  parseUrlPath,
  readJsonBody,
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
    })
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

async function runWithFallback(system: string, user: string, fallback: string): Promise<{ text: string; mode: "claude" | "fallback" }> {
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

const server = createServer(async (req, res) => {
  const path = parseUrlPath(req.url);
  const method = req.method ?? "GET";
  const ctx = requestContext(req);

  if (path === "/metrics") {
    sendMetrics(res);
    return;
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

  if (path === "/internal/v1/ai/campaign-draft") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<DraftCampaignRequest>(req);
    if (!payload.objective || !payload.audienceDescription || !payload.offer || !payload.tone || !payload.language) {
      sendJson(res, 400, { error: "objective, audienceDescription, offer, tone and language are required" });
      return;
    }

    const system = "You are a B2B WhatsApp marketing assistant. Output policy-safe campaign drafts only. Never bypass consent or template policy.";
    const user = `Create a concise campaign draft. Objective: ${payload.objective}. Audience: ${payload.audienceDescription}. Offer: ${payload.offer}. Tone: ${payload.tone}. Language: ${payload.language}. Include a clear opt-out reminder.`;
    const fallback = fallbackCampaignDraft(payload);

    const result = await runWithFallback(system, user, fallback);
    sendJson(res, 200, {
      requestId: ctx.requestId,
      mode: result.mode,
      draft: result.text
    });
    return;
  }

  if (path === "/internal/v1/ai/segment-summary") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<SegmentSummaryRequest>(req);
    if (!payload.segmentName || payload.contacts <= 0) {
      sendJson(res, 400, { error: "segmentName and contacts (>0) are required" });
      return;
    }

    const system = "You summarize marketing segment quality and operational risk for internal analysts.";
    const user = `Summarize segment ${payload.segmentName} with contacts=${payload.contacts}, conversionRate=${payload.conversionRate}, optOutRate=${payload.optOutRate}. Output max 5 bullet points.`;
    const fallback = fallbackSegmentSummary(payload);

    const result = await runWithFallback(system, user, fallback);
    sendJson(res, 200, {
      requestId: ctx.requestId,
      mode: result.mode,
      summary: result.text
    });
    return;
  }

  if (path === "/internal/v1/ai/lead-score") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const payload = await readJsonBody<LeadScoreRequest>(req);
    const score = fallbackLeadScore(payload);

    sendJson(res, 200, {
      requestId: ctx.requestId,
      score,
      scale: "0-100",
      recommendation:
        score >= 75
          ? "Prioritize for marketing follow-up"
          : score >= 45
            ? "Nurture with informational template"
            : "Low priority; suppress from high-frequency campaigns"
    });
    return;
  }

  notFound(res);
});

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
