export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolMax: number;
  ssl: boolean;
  sslRejectUnauthorized: boolean;
}

export interface KeycloakConfig {
  baseUrl: string;
  realm: string;
  issuer: string;
  jwksUri: string;
  audience: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
}

export interface PlatformConfig {
  nodeEnv: string;
  logLevel: string;
  platformBaseUrl: string;
  database: DatabaseConfig;
  keycloak: KeycloakConfig;
  redis: RedisConfig;
  authEnabled: boolean;
  eventBus: "rabbitmq" | "memory";
  rabbitmqUrl: string;
  apiGatewayPort: number;
  metaAdapterPort: number;
  webhookIngestorPort: number;
  notificationWorkerPort: number;
  aiIntelligencePort: number;
  webhookVerifyToken: string;
  metaAppSecret: string;
  webhookIngestorUrl: string;
  metaAdapterUrl: string;
  notificationWorkerUrl: string;
  aiIntelligenceUrl: string;
  whatsappGraphVersion: string;
  whatsappWabaId: string;
  whatsappPhoneNumberId: string;
  whatsappAccessToken: string;
  whatsappRegisterPin: string;
  channelEncryptionKey: string;
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

const PLACEHOLDER_SECRETS = new Set(["", "change-me", "replace-me"]);

/**
 * Returns the secret value, but refuses to start in production when it is
 * still unset or carries a known placeholder. This prevents shipping a
 * deployment that trusts default credentials.
 */
function requireSecret(name: string, value: string | undefined, isProduction: boolean): string {
  const resolved = value ?? "";
  if (isProduction && PLACEHOLDER_SECRETS.has(resolved.trim())) {
    throw new Error(`Refusing to start: ${name} must be set to a non-default value in production`);
  }
  return resolved;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  const keycloakBaseUrl = (env.KEYCLOAK_BASE_URL ?? "http://keycloak:8080").replace(/\/+$/, "");
  const keycloakRealm = env.KEYCLOAK_REALM ?? "hyfib-wa";
  const keycloakIssuer = env.KEYCLOAK_ISSUER ?? `${keycloakBaseUrl}/realms/${keycloakRealm}`;

  const rabbitUser = env.RABBITMQ_DEFAULT_USER ?? "platform";
  const rabbitPass = env.RABBITMQ_DEFAULT_PASS ?? "";
  const rabbitHost = env.RABBITMQ_HOST ?? "rabbitmq";
  const rabbitPort = parseNumber("RABBITMQ_PORT", env.RABBITMQ_PORT, 5672);
  const rabbitmqUrl =
    env.RABBITMQ_URL ??
    `amqp://${encodeURIComponent(rabbitUser)}:${encodeURIComponent(rabbitPass)}@${rabbitHost}:${rabbitPort}`;

  return {
    nodeEnv,
    logLevel: env.LOG_LEVEL ?? "info",
    platformBaseUrl: env.PLATFORM_BASE_URL ?? "http://localhost:8080",
    database: {
      host: env.POSTGRES_HOST ?? "postgres-primary",
      port: parseNumber("POSTGRES_PORT", env.POSTGRES_PORT, 5432),
      user: env.POSTGRES_APP_USER ?? "hyfib_app",
      password: requireSecret("POSTGRES_APP_PASSWORD", env.POSTGRES_APP_PASSWORD, isProduction),
      database: env.POSTGRES_DB ?? "hyfib_wa",
      poolMax: parseNumber("DB_POOL_MAX", env.DB_POOL_MAX, 10),
      ssl: parseBoolean(env.POSTGRES_SSL, false),
      sslRejectUnauthorized: parseBoolean(env.POSTGRES_SSL_REJECT_UNAUTHORIZED, true)
    },
    keycloak: {
      baseUrl: keycloakBaseUrl,
      realm: keycloakRealm,
      issuer: keycloakIssuer,
      jwksUri: env.KEYCLOAK_JWKS_URI ?? `${keycloakIssuer}/protocol/openid-connect/certs`,
      audience: env.KEYCLOAK_AUDIENCE ?? "hyfib-platform"
    },
    redis: {
      host: env.REDIS_HOST ?? "redis-master",
      port: parseNumber("REDIS_PORT", env.REDIS_PORT, 6379),
      password: env.REDIS_PASSWORD ?? ""
    },
    authEnabled: parseBoolean(env.AUTH_ENABLED, true),
    eventBus: (env.EVENT_BUS ?? "rabbitmq") === "memory" ? "memory" : "rabbitmq",
    rabbitmqUrl,
    apiGatewayPort: parseNumber("API_GATEWAY_PORT", env.API_GATEWAY_PORT, 8080),
    metaAdapterPort: parseNumber("META_ADAPTER_PORT", env.META_ADAPTER_PORT, 8092),
    webhookIngestorPort: parseNumber("WEBHOOK_INGESTOR_PORT", env.WEBHOOK_INGESTOR_PORT, 8093),
    notificationWorkerPort: parseNumber("NOTIFICATION_WORKER_PORT", env.NOTIFICATION_WORKER_PORT, 8094),
    aiIntelligencePort: parseNumber("AI_INTELLIGENCE_PORT", env.AI_INTELLIGENCE_PORT, 8095),
    webhookVerifyToken: requireSecret("WEBHOOK_VERIFY_TOKEN", env.WEBHOOK_VERIFY_TOKEN, isProduction),
    metaAppSecret: requireSecret("META_APP_SECRET", env.META_APP_SECRET, isProduction),
    webhookIngestorUrl: env.WEBHOOK_INGESTOR_URL ?? "http://webhook-ingestor:8093",
    metaAdapterUrl: env.META_ADAPTER_URL ?? "http://meta-adapter:8092",
    notificationWorkerUrl: env.NOTIFICATION_WORKER_URL ?? "http://notification-worker:8094",
    aiIntelligenceUrl: env.AI_INTELLIGENCE_URL ?? "http://ai-intelligence-service:8095",
    whatsappGraphVersion: env.WHATSAPP_GRAPH_VERSION ?? "v22.0",
    whatsappWabaId: env.WHATSAPP_WABA_ID ?? "",
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
    whatsappRegisterPin: env.WHATSAPP_REGISTER_PIN ?? "",
    channelEncryptionKey: env.CHANNEL_ENCRYPTION_KEY ?? "",
    vaultAddr: env.VAULT_ADDR ?? "http://vault:8200",
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    anthropicMaxTokens: parseNumber("ANTHROPIC_MAX_TOKENS", env.ANTHROPIC_MAX_TOKENS, 1500),
    aiDeterministicFallback: parseBoolean(env.AI_DETERMINISTIC_FALLBACK, true)
  };
}
