export interface PlatformConfig {
  nodeEnv: string;
  logLevel: string;
  platformBaseUrl: string;
  apiGatewayPort: number;
  authServicePort: number;
  tenantServicePort: number;
  contactServicePort: number;
  conversationServicePort: number;
  campaignServicePort: number;
  templateServicePort: number;
  commerceServicePort: number;
  billingUsageServicePort: number;
  reportingServicePort: number;
  auditServicePort: number;
  metaAdapterPort: number;
  webhookIngestorPort: number;
  notificationWorkerPort: number;
  aiIntelligencePort: number;
  webhookVerifyToken: string;
  metaAppSecret: string;
  webhookIngestorUrl: string;
  metaAdapterUrl: string;
  aiIntelligenceUrl: string;
  whatsappGraphVersion: string;
  whatsappWabaId: string;
  whatsappPhoneNumberId: string;
  whatsappAccessToken: string;
  whatsappRegisterPin: string;
  vaultAddr: string;
  anthropicModel: string;
  anthropicApiKey: string;
  anthropicMaxTokens: number;
  aiDeterministicFallback: boolean;
}

function parseNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric configuration for ${name}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    logLevel: env.LOG_LEVEL ?? "info",
    platformBaseUrl: env.PLATFORM_BASE_URL ?? "http://localhost:8080",
    apiGatewayPort: parseNumber("API_GATEWAY_PORT", env.API_GATEWAY_PORT, 8080),
    authServicePort: parseNumber("AUTH_SERVICE_PORT", env.AUTH_SERVICE_PORT, 8082),
    tenantServicePort: parseNumber("TENANT_SERVICE_PORT", env.TENANT_SERVICE_PORT, 8083),
    contactServicePort: parseNumber("CONTACT_SERVICE_PORT", env.CONTACT_SERVICE_PORT, 8084),
    conversationServicePort: parseNumber("CONVERSATION_SERVICE_PORT", env.CONVERSATION_SERVICE_PORT, 8085),
    campaignServicePort: parseNumber("CAMPAIGN_SERVICE_PORT", env.CAMPAIGN_SERVICE_PORT, 8086),
    templateServicePort: parseNumber("TEMPLATE_SERVICE_PORT", env.TEMPLATE_SERVICE_PORT, 8087),
    commerceServicePort: parseNumber("COMMERCE_SERVICE_PORT", env.COMMERCE_SERVICE_PORT, 8088),
    billingUsageServicePort: parseNumber("BILLING_USAGE_SERVICE_PORT", env.BILLING_USAGE_SERVICE_PORT, 8089),
    reportingServicePort: parseNumber("REPORTING_SERVICE_PORT", env.REPORTING_SERVICE_PORT, 8090),
    auditServicePort: parseNumber("AUDIT_SERVICE_PORT", env.AUDIT_SERVICE_PORT, 8091),
    metaAdapterPort: parseNumber("META_ADAPTER_PORT", env.META_ADAPTER_PORT, 8092),
    webhookIngestorPort: parseNumber("WEBHOOK_INGESTOR_PORT", env.WEBHOOK_INGESTOR_PORT, 8093),
    notificationWorkerPort: parseNumber("NOTIFICATION_WORKER_PORT", env.NOTIFICATION_WORKER_PORT, 8094),
    aiIntelligencePort: parseNumber("AI_INTELLIGENCE_PORT", env.AI_INTELLIGENCE_PORT, 8095),
    webhookVerifyToken: env.WEBHOOK_VERIFY_TOKEN ?? "replace-me",
    metaAppSecret: env.META_APP_SECRET ?? "replace-me",
    webhookIngestorUrl: env.WEBHOOK_INGESTOR_URL ?? "http://webhook-ingestor:8093",
    metaAdapterUrl: env.META_ADAPTER_URL ?? "http://meta-adapter:8092",
    aiIntelligenceUrl: env.AI_INTELLIGENCE_URL ?? "http://ai-intelligence-service:8095",
    whatsappGraphVersion: env.WHATSAPP_GRAPH_VERSION ?? "v22.0",
    whatsappWabaId: env.WHATSAPP_WABA_ID ?? "",
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
    whatsappRegisterPin: env.WHATSAPP_REGISTER_PIN ?? "",
    vaultAddr: env.VAULT_ADDR ?? "http://vault:8200",
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    anthropicMaxTokens: parseNumber("ANTHROPIC_MAX_TOKENS", env.ANTHROPIC_MAX_TOKENS, 1500),
    aiDeterministicFallback: parseBoolean(env.AI_DETERMINISTIC_FALLBACK, true)
  };
}
