import { query, withTenant, type QueryClient } from "./db.js";
import { loadConfig } from "@hyfib/config";
import { decryptSecret, encryptSecret } from "@hyfib/shared-core";
import type {
  AuditEvent,
  AutoReplyRule,
  AutomationActionConfig,
  AutomationConditions,
  AutomationRule,
  Campaign,
  CampaignRecipient,
  ContactNote,
  ConversationNote,
  Contact,
  Conversation,
  FrequencyCapConfig,
  Message,
  MessageCategory,
  Order,
  QuietHoursConfig,
  Role,
  Segment,
  Tag,
  Task,
  Team,
  SavedReply,
  Template,
  Tenant,
  User,
  VariableMapping,
  WhatsAppSettings,
  WhatsAppChannel
} from "@hyfib/shared-core";

export type CampaignWithTemplate = Campaign & {
  templateName: string;
  templateLanguage: string;
  templateStatus: string;
  sentCount: number;
  failedCount: number;
  deliveredCount: number;
  readCount: number;
};

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status as Tenant["status"],
    createdAt: row.created_at.toISOString()
  };
}

export const tenantRepository = {
  async create(name: string): Promise<Tenant> {
    const result = await query<TenantRow>(
      "INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, status, created_at",
      [name]
    );
    return mapTenant(result.rows[0]!);
  },
  async list(): Promise<Tenant[]> {
    const result = await query<TenantRow>("SELECT id, name, status, created_at FROM tenants ORDER BY created_at DESC");
    return result.rows.map(mapTenant);
  },
  async getById(id: string): Promise<Tenant | undefined> {
    const result = await query<TenantRow>("SELECT id, name, status, created_at FROM tenants WHERE id = $1", [id]);
    return result.rows[0] ? mapTenant(result.rows[0]) : undefined;
  }
};

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  status: string;
  roles: string[];
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    roles: row.roles as Role[],
    status: row.status as User["status"]
  };
}

const USER_SELECT = `
  SELECT u.id, u.tenant_id, u.email, u.display_name, u.status,
         COALESCE(ARRAY_AGG(rb.role) FILTER (WHERE rb.role IS NOT NULL), '{}') AS roles
  FROM users u
  LEFT JOIN role_bindings rb ON rb.user_id = u.id
`;

export const userRepository = {
  async create(tenantId: string, input: { email: string; displayName: string; roles: Role[] }): Promise<User> {
    return withTenant(tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO users (tenant_id, email, display_name) VALUES ($1, $2, $3) RETURNING id",
        [tenantId, input.email, input.displayName]
      );
      const userId = inserted.rows[0]!.id;
      for (const role of input.roles) {
        await client.query(
          "INSERT INTO role_bindings (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [tenantId, userId, role]
        );
      }
      const result = await client.query<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [userId]);
      return mapUser(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<User[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<UserRow>(`${USER_SELECT} GROUP BY u.id ORDER BY u.created_at DESC`);
      return result.rows.map(mapUser);
    });
  },
  /** Tenant-scoped lookup (RLS-enforced); used to validate assignee membership. */
  async getById(tenantId: string, id: string): Promise<User | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    });
  }
};

interface TeamRow {
  id: string;
  tenant_id: string;
  name: string;
  is_default: boolean;
  created_at: Date;
}

function mapTeam(row: TeamRow): Team {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    isDefault: row.is_default,
    createdAt: row.created_at.toISOString()
  };
}

export const teamRepository = {
  async create(tenantId: string, input: { name: string; isDefault?: boolean }): Promise<Team> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TeamRow>(
        `INSERT INTO teams (tenant_id, name, is_default)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, name, is_default, created_at`,
        [tenantId, input.name, input.isDefault ?? false]
      );
      return mapTeam(result.rows[0]!);
    });
  },
  async update(tenantId: string, id: string, input: { name?: string }): Promise<Team | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TeamRow>(
        `UPDATE teams SET name = COALESCE($2, name)
         WHERE id = $1
         RETURNING id, tenant_id, name, is_default, created_at`,
        [id, input.name ?? null]
      );
      return result.rows[0] ? mapTeam(result.rows[0]) : undefined;
    });
  },
  async list(tenantId: string): Promise<Team[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TeamRow>(
        "SELECT id, tenant_id, name, is_default, created_at FROM teams ORDER BY is_default DESC, name ASC"
      );
      return result.rows.map(mapTeam);
    });
  },
  async getById(tenantId: string, id: string): Promise<Team | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TeamRow>(
        "SELECT id, tenant_id, name, is_default, created_at FROM teams WHERE id = $1",
        [id]
      );
      return result.rows[0] ? mapTeam(result.rows[0]) : undefined;
    });
  },
  async addMember(tenantId: string, teamId: string, userId: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO team_members (tenant_id, team_id, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, team_id, user_id) DO NOTHING`,
        [tenantId, teamId, userId]
      );
    });
  },
  async removeMember(tenantId: string, teamId: string, userId: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
    });
  },
  async listMembers(tenantId: string, teamId: string): Promise<User[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<UserRow>(
        `${USER_SELECT} JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = $1 GROUP BY u.id ORDER BY u.created_at ASC`,
        [teamId]
      );
      return result.rows.map(mapUser);
    });
  }
};

interface WhatsAppSettingsRow {
  id: string;
  tenant_id: string;
  status_callback_url: string | null;
  graph_version: string;
  retry_max_attempts: number;
  retry_base_delay_ms: number;
  outbound_rate_limit_per_minute: number | null;
  created_at: Date;
  updated_at: Date;
}

function mapWhatsAppSettings(row: WhatsAppSettingsRow): WhatsAppSettings {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    statusCallbackUrl: row.status_callback_url ?? undefined,
    graphVersion: row.graph_version,
    retryMaxAttempts: row.retry_max_attempts,
    retryBaseDelayMs: row.retry_base_delay_ms,
    outboundRateLimitPerMinute: row.outbound_rate_limit_per_minute ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const WHATSAPP_SETTINGS_SELECT =
  "SELECT id, tenant_id, status_callback_url, graph_version, retry_max_attempts, retry_base_delay_ms, outbound_rate_limit_per_minute, created_at, updated_at";

export const whatsappSettingsRepository = {
  async upsert(
    tenantId: string,
    input: {
      statusCallbackUrl?: string;
      graphVersion: string;
      retryMaxAttempts: number;
      retryBaseDelayMs: number;
      outboundRateLimitPerMinute?: number;
    }
  ): Promise<WhatsAppSettings> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<WhatsAppSettingsRow>(
        `INSERT INTO whatsapp_settings (
          tenant_id,
          status_callback_url,
          graph_version,
          retry_max_attempts,
          retry_base_delay_ms,
          outbound_rate_limit_per_minute,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (tenant_id) DO UPDATE
          SET status_callback_url = EXCLUDED.status_callback_url,
              graph_version = EXCLUDED.graph_version,
              retry_max_attempts = EXCLUDED.retry_max_attempts,
              retry_base_delay_ms = EXCLUDED.retry_base_delay_ms,
              outbound_rate_limit_per_minute = EXCLUDED.outbound_rate_limit_per_minute,
              updated_at = now()
        RETURNING ${WHATSAPP_SETTINGS_SELECT}`,
        [
          tenantId,
          input.statusCallbackUrl ?? null,
          input.graphVersion,
          input.retryMaxAttempts,
          input.retryBaseDelayMs,
          input.outboundRateLimitPerMinute ?? null
        ]
      );
      return mapWhatsAppSettings(result.rows[0]!);
    });
  },
  async getByTenant(tenantId: string): Promise<WhatsAppSettings | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<WhatsAppSettingsRow>(
        `${WHATSAPP_SETTINGS_SELECT} FROM whatsapp_settings
         WHERE tenant_id = current_setting('app.tenant_id', true)::uuid LIMIT 1`
      );
      return result.rows[0] ? mapWhatsAppSettings(result.rows[0]) : undefined;
    });
  }
};

interface ChannelRow {
  id: string;
  tenant_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  quality_rating: string | null;
  is_active: boolean;
  created_at: Date;
  has_access_token: boolean;
}

interface ChannelCredentialRow extends ChannelRow {
  access_token_encrypted: string | null;
}

const CHANNEL_COLUMNS =
  "id, tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active, created_at, (access_token_encrypted IS NOT NULL) AS has_access_token";

function mapChannel(row: ChannelRow): WhatsAppChannel {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    qualityRating: (row.quality_rating as WhatsAppChannel["qualityRating"]) ?? "unknown",
    status: row.is_active ? "active" : "inactive",
    hasAccessToken: row.has_access_token,
    createdAt: row.created_at.toISOString()
  };
}

// Channel credential TTL cache: each entry expires after 5 minutes.
// Channels change infrequently; this eliminates N DB round-trips in campaign fan-out.
const CHANNEL_CREDS_TTL_MS = 5 * 60 * 1000;
interface CachedCreds { value: ChannelCredentials; expiresAt: number; }
interface CachedResolved { value: ResolvedChannel | undefined; expiresAt: number; }
const credsByChannelIdCache = new Map<string, CachedCreds>();
const resolvedByPhoneNumberIdCache = new Map<string, CachedResolved>();

/** Resolved channel send credentials (number + optional per-tenant token). */
export interface ChannelCredentials {
  id: string;
  wabaId: string;
  phoneNumberId: string;
  /** Decrypted per-channel access token, or undefined to fall back to the env token. */
  accessToken?: string;
}

function encryptChannelToken(token: string): string {
  const key = loadConfig().channelEncryptionKey;
  if (!key) {
    throw new Error("CHANNEL_ENCRYPTION_KEY must be set to register a channel with its own access token");
  }
  return encryptSecret(token, key);
}

function mapChannelCredentials(row: ChannelCredentialRow): ChannelCredentials {
  let accessToken: string | undefined;
  if (row.access_token_encrypted) {
    accessToken = decryptSecret(row.access_token_encrypted, loadConfig().channelEncryptionKey);
  }
  return { id: row.id, wabaId: row.waba_id, phoneNumberId: row.phone_number_id, accessToken };
}

export const channelRepository = {
  async create(
    tenantId: string,
    input: { wabaId: string; phoneNumberId: string; displayPhoneNumber: string; accessToken?: string }
  ): Promise<WhatsAppChannel> {
    const encryptedToken = input.accessToken ? encryptChannelToken(input.accessToken) : null;
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelRow>(
        `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active, access_token_encrypted)
         VALUES ($1, $2, $3, $4, 'unknown', true, $5)
         RETURNING ${CHANNEL_COLUMNS}`,
        [tenantId, input.wabaId, input.phoneNumberId, input.displayPhoneNumber, encryptedToken]
      );
      return mapChannel(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<WhatsAppChannel[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelRow>(
        `SELECT ${CHANNEL_COLUMNS} FROM whatsapp_channels ORDER BY created_at DESC`
      );
      return result.rows.map(mapChannel);
    });
  },
  async firstActive(tenantId: string): Promise<WhatsAppChannel | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelRow>(
        `SELECT ${CHANNEL_COLUMNS} FROM whatsapp_channels WHERE is_active = true ORDER BY created_at ASC LIMIT 1`
      );
      return result.rows[0] ? mapChannel(result.rows[0]) : undefined;
    });
  },
  /** Loads a channel's send credentials (number + decrypted token) by id. Cached for 5 min. */
  async getCredentials(tenantId: string, channelId: string): Promise<ChannelCredentials | undefined> {
    const cacheKey = `${tenantId}:${channelId}`;
    const cached = credsByChannelIdCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const creds = await withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelCredentialRow>(
        `SELECT ${CHANNEL_COLUMNS}, access_token_encrypted FROM whatsapp_channels WHERE id = $1`,
        [channelId]
      );
      return result.rows[0] ? mapChannelCredentials(result.rows[0]) : undefined;
    });
    if (creds) {
      credsByChannelIdCache.set(cacheKey, { value: creds, expiresAt: Date.now() + CHANNEL_CREDS_TTL_MS });
    }
    return creds;
  }
};

interface TemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  language: string;
  status: string;
  body: string;
}

function mapTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    category: row.category as MessageCategory,
    language: row.language,
    status: row.status as Template["status"],
    body: row.body
  };
}

export interface TemplateListOptions {
  status?: string;
  offset?: number;
  limit?: number;
}

export const templateRepository = {
  async create(
    tenantId: string,
    input: { name: string; category: MessageCategory; language: string; body: string; status?: Template["status"] }
  ): Promise<Template> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TemplateRow>(
        `INSERT INTO templates (tenant_id, name, category, language, status, body)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, name, category, language, status, body`,
        [tenantId, input.name, input.category, input.language, input.status ?? "pending", input.body]
      );
      return mapTemplate(result.rows[0]!);
    });
  },
  async list(tenantId: string, opts?: TemplateListOptions): Promise<Template[]> {
    return withTenant(tenantId, async (client) => {
      const params: unknown[] = [];
      const conditions: string[] = [];
      if (opts?.status) {
        params.push(opts.status);
        conditions.push(`status = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limitClause = opts?.limit != null ? ` LIMIT $${params.push(opts.limit)}` : "";
      const offsetClause = opts?.offset != null ? ` OFFSET $${params.push(opts.offset)}` : "";
      const result = await client.query<TemplateRow>(
        `SELECT id, tenant_id, name, category, language, status, body FROM templates ${where} ORDER BY created_at DESC${limitClause}${offsetClause}`,
        params
      );
      return result.rows.map(mapTemplate);
    });
  },
  async getById(tenantId: string, id: string): Promise<Template | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TemplateRow>(
        "SELECT id, tenant_id, name, category, language, status, body FROM templates WHERE id = $1",
        [id]
      );
      return result.rows[0] ? mapTemplate(result.rows[0]) : undefined;
    });
  },
  /**
   * Upserts a template pulled from Meta, reconciling local status/category/body
   * with the remote source of truth. Keyed by (tenant, name, language).
   */
  async upsertFromMeta(
    tenantId: string,
    input: { name: string; language: string; status: Template["status"]; category: MessageCategory; body: string }
  ): Promise<Template> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TemplateRow>(
        `INSERT INTO templates (tenant_id, name, category, language, status, body)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, name, language) DO UPDATE
           SET status = EXCLUDED.status, category = EXCLUDED.category, body = EXCLUDED.body
         RETURNING id, tenant_id, name, category, language, status, body`,
        [tenantId, input.name, input.category, input.language, input.status, input.body]
      );
      return mapTemplate(result.rows[0]!);
    });
  }
};

interface CampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  template_id: string;
  status: string;
  created_at: Date;
  template_name: string;
  template_language: string;
  template_category: string;
  template_status: string | null;
  sent_count: string | null;
  failed_count: string | null;
  delivered_count: string | null;
  read_count: string | null;
  segment_id: string | null;
  scheduled_at: Date | null;
  variable_mapping: VariableMapping | null;
  rate_per_minute: number | null;
  quiet_hours: QuietHoursConfig | null;
  frequency_cap: FrequencyCapConfig | null;
}

function mapCampaign(row: CampaignRow): CampaignWithTemplate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    templateId: row.template_id,
    templateCategory: row.template_category as MessageCategory,
    status: row.status as Campaign["status"],
    createdAt: row.created_at.toISOString(),
    templateName: row.template_name,
    templateLanguage: row.template_language,
    templateStatus: row.template_status ?? "pending",
    sentCount: Number(row.sent_count ?? "0"),
    failedCount: Number(row.failed_count ?? "0"),
    deliveredCount: Number(row.delivered_count ?? "0"),
    readCount: Number(row.read_count ?? "0"),
    segmentId: row.segment_id ?? undefined,
    scheduledAt: row.scheduled_at?.toISOString(),
    variableMapping: row.variable_mapping ?? undefined,
    ratePerMinute: row.rate_per_minute ?? undefined,
    quietHours: row.quiet_hours ?? undefined,
    frequencyCap: row.frequency_cap ?? undefined
  };
}

const CAMPAIGN_SELECT = `
  SELECT c.id, c.tenant_id, c.name, c.template_id, c.status, c.created_at,
         c.segment_id, c.scheduled_at, c.variable_mapping, c.rate_per_minute,
         c.quiet_hours, c.frequency_cap,
         t.name AS template_name, t.language AS template_language, t.category AS template_category, t.status AS template_status,
         s.sent_count, s.failed_count, s.delivered_count, s.read_count
  FROM campaigns c
  JOIN templates t ON t.id = c.template_id
  LEFT JOIN campaign_stats s ON s.campaign_id = c.id
`;

export const campaignRepository = {
  async create(
    tenantId: string,
    input: {
      name: string;
      templateId: string;
      segmentId?: string;
      scheduledAt?: string;
      variableMapping?: VariableMapping;
      ratePerMinute?: number;
      quietHours?: QuietHoursConfig;
      frequencyCap?: FrequencyCapConfig;
    }
  ): Promise<CampaignWithTemplate> {
    return withTenant(tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO campaigns
           (tenant_id, name, template_id, status, segment_id, scheduled_at, variable_mapping, rate_per_minute, quiet_hours, frequency_cap)
         VALUES ($1, $2, $3,
           CASE WHEN $4::timestamptz IS NOT NULL THEN 'scheduled' ELSE 'draft' END,
           $5, $4, $6::jsonb, $7, $8::jsonb, $9::jsonb)
         RETURNING id`,
        [
          tenantId,
          input.name,
          input.templateId,
          input.scheduledAt ?? null,
          input.segmentId ?? null,
          input.variableMapping ? JSON.stringify(input.variableMapping) : null,
          input.ratePerMinute ?? null,
          input.quietHours ? JSON.stringify(input.quietHours) : null,
          input.frequencyCap ? JSON.stringify(input.frequencyCap) : null
        ]
      );
      const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [inserted.rows[0]!.id]);
      return mapCampaign(result.rows[0]!);
    });
  },
  async list(
    tenantId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ items: CampaignWithTemplate[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    return withTenant(tenantId, async (client) => {
      const totalResult = await client.query<{ total: string }>("SELECT COUNT(*)::text AS total FROM campaigns");
      const result = await client.query<CampaignRow>(
        `${CAMPAIGN_SELECT} ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return { items: result.rows.map(mapCampaign), total: Number(totalResult.rows[0]?.total ?? "0") };
    });
  },
  async getById(tenantId: string, id: string): Promise<CampaignWithTemplate | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id]);
      return result.rows[0] ? mapCampaign(result.rows[0]) : undefined;
    });
  },
  async setStatus(tenantId: string, id: string, status: Campaign["status"]): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE campaigns SET status = $2 WHERE id = $1", [id, status]);
    });
  }
};

export const campaignStatsRepository = {
  /** Idempotently records a per-contact dispatch outcome onto the campaign tally. */
  async recordResult(tenantId: string, campaignId: string, outcome: "sent" | "failed"): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO campaign_stats (tenant_id, campaign_id, sent_count, failed_count, last_result_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, campaign_id) DO UPDATE
           SET sent_count = campaign_stats.sent_count + EXCLUDED.sent_count,
               failed_count = campaign_stats.failed_count + EXCLUDED.failed_count,
               last_result_at = now()`,
        [tenantId, campaignId, outcome === "sent" ? 1 : 0, outcome === "failed" ? 1 : 0]
      );
    });
  },
  async recordDelivered(tenantId: string, campaignId: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO campaign_stats (tenant_id, campaign_id, delivered_count, last_result_at)
         VALUES ($1, $2, 1, now())
         ON CONFLICT (tenant_id, campaign_id) DO UPDATE
           SET delivered_count = campaign_stats.delivered_count + 1, last_result_at = now()`,
        [tenantId, campaignId]
      );
    });
  },
  async recordRead(tenantId: string, campaignId: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO campaign_stats (tenant_id, campaign_id, read_count, last_result_at)
         VALUES ($1, $2, 1, now())
         ON CONFLICT (tenant_id, campaign_id) DO UPDATE
           SET read_count = campaign_stats.read_count + 1, last_result_at = now()`,
        [tenantId, campaignId]
      );
    });
  }
};

interface ContactRow {
  id: string;
  tenant_id: string;
  phone_e164: string;
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  metadata: { optedOut?: boolean; country?: string; tags?: string[]; customFields?: Record<string, string> };
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    phoneE164: row.phone_e164,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    optedOut: row.metadata?.optedOut ?? false,
    country: row.metadata?.country,
    tags: row.metadata?.tags ?? [],
    timezone: row.timezone ?? undefined,
    customFields: row.metadata?.customFields ?? {}
  };
}

const CONTACT_SELECT = "SELECT id, tenant_id, phone_e164, first_name, last_name, timezone, metadata";

export const contactRepository = {
  async create(
    tenantId: string,
    input: {
      phoneE164: string;
      firstName?: string;
      lastName?: string;
      country?: string;
      tags?: string[];
      timezone?: string;
    }
  ): Promise<Contact> {
    return withTenant(tenantId, async (client) => {
      const metadata = { optedOut: false, country: input.country, tags: input.tags ?? [] };
      const result = await client.query<ContactRow>(
        `INSERT INTO contacts (tenant_id, phone_e164, first_name, last_name, timezone, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, tenant_id, phone_e164, first_name, last_name, timezone, metadata`,
        [
          tenantId,
          input.phoneE164,
          input.firstName ?? null,
          input.lastName ?? null,
          input.timezone ?? null,
          JSON.stringify(metadata)
        ]
      );
      return mapContact(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<Contact[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(`${CONTACT_SELECT} FROM contacts ORDER BY created_at DESC`);
      return result.rows.map(mapContact);
    });
  },
  /** Search/filter/paginate contacts for the CRM contact list. */
  async search(
    tenantId: string,
    opts: { query?: string; tag?: string; optedOut?: boolean; limit: number; offset: number }
  ): Promise<{ items: Contact[]; total: number }> {
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (opts.query) {
        params.push(`%${opts.query}%`);
        const idx = params.length;
        conditions.push(`(first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR phone_e164 ILIKE $${idx})`);
      }
      if (opts.tag) {
        params.push(opts.tag);
        conditions.push(`metadata->'tags' ? $${params.length}`);
      }
      if (opts.optedOut !== undefined) {
        params.push(opts.optedOut);
        conditions.push(`COALESCE((metadata->>'optedOut')::boolean, false) = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const totalResult = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM contacts ${where}`,
        params
      );
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;
      const result = await client.query<ContactRow>(
        `${CONTACT_SELECT} FROM contacts ${where} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...params, opts.limit, opts.offset]
      );
      return { items: result.rows.map(mapContact), total: Number(totalResult.rows[0]?.total ?? "0") };
    });
  },
  /** Adds a tag to a contact's metadata.tags set (idempotent). */
  async addTag(tenantId: string, contactId: string, tag: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE contacts
         SET metadata = jsonb_set(
           metadata,
           '{tags}',
           (
             SELECT to_jsonb(ARRAY(
               SELECT DISTINCT t FROM unnest(
                 COALESCE(ARRAY(SELECT jsonb_array_elements_text(metadata->'tags')), '{}'::text[]) || ARRAY[$2]
               ) AS t
             ))
           )
         )
         WHERE id = $1`,
        [contactId, tag]
      );
    });
  },
  /** Removes a tag from a contact's metadata.tags set. */
  async removeTag(tenantId: string, contactId: string, tag: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE contacts
         SET metadata = jsonb_set(
           metadata,
           '{tags}',
           (
             SELECT to_jsonb(ARRAY(
               SELECT t FROM jsonb_array_elements_text(COALESCE(metadata->'tags', '[]'::jsonb)) AS t
               WHERE t <> $2
             ))
           )
         )
         WHERE id = $1`,
        [contactId, tag]
      );
    });
  },
  /** Sets (or, when value is null, removes) a custom field stored in metadata.customFields. */
  async setCustomField(tenantId: string, contactId: string, key: string, value: string | null): Promise<void> {
    await withTenant(tenantId, async (client) => {
      if (value === null) {
        await client.query("UPDATE contacts SET metadata = metadata #- ARRAY['customFields', $2] WHERE id = $1", [
          contactId,
          key
        ]);
        return;
      }
      await client.query(
        `UPDATE contacts
         SET metadata = jsonb_set(
           jsonb_set(metadata, '{customFields}', COALESCE(metadata->'customFields', '{}'::jsonb)),
           ARRAY['customFields', $2],
           to_jsonb($3::text)
         )
         WHERE id = $1`,
        [contactId, key, value]
      );
    });
  },
  async findByPhone(tenantId: string, phoneE164: string): Promise<Contact | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(`${CONTACT_SELECT} FROM contacts WHERE phone_e164 = $1`, [
        phoneE164
      ]);
      return result.rows[0] ? mapContact(result.rows[0]) : undefined;
    });
  },
  /** Used by the inbound-message consumer to ensure a contact exists. */
  async findOrCreateByPhone(tenantId: string, phoneE164: string): Promise<Contact> {
    return withTenant(tenantId, async (client) => {
      const inserted = await client.query<ContactRow>(
        `INSERT INTO contacts (tenant_id, phone_e164, metadata)
         VALUES ($1, $2, '{"optedOut":false,"tags":[]}'::jsonb)
         ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
         RETURNING id, tenant_id, phone_e164, first_name, last_name, timezone, metadata`,
        [tenantId, phoneE164]
      );
      return mapContact(inserted.rows[0]!);
    });
  },
  async getById(tenantId: string, id: string): Promise<Contact | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(`${CONTACT_SELECT} FROM contacts WHERE id = $1`, [id]);
      return result.rows[0] ? mapContact(result.rows[0]) : undefined;
    });
  },
  async getByIds(tenantId: string, ids: string[]): Promise<Map<string, Contact>> {
    if (ids.length === 0) return new Map();
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(
        `${CONTACT_SELECT} FROM contacts WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      return new Map(result.rows.map((r) => [r.id, mapContact(r)]));
    });
  },
  async setOptedOut(tenantId: string, contactId: string, optedOut: boolean): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        "UPDATE contacts SET metadata = jsonb_set(metadata, '{optedOut}', to_jsonb($2::boolean)) WHERE id = $1",
        [contactId, optedOut]
      );
    });
  },
  /**
   * Bulk-upsert contacts from a CSV/JSON import.
   * Returns { created, updated, skipped } counts.
   * Processes in chunks of 500 to stay under pg parameter limits.
   */
  async bulkUpsert(
    tenantId: string,
    rows: Array<{
      phoneE164: string;
      firstName?: string;
      lastName?: string;
      country?: string;
      tags?: string[];
      timezone?: string;
      grantConsent?: boolean;
    }>
  ): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await withTenant(tenantId, async (client) => {
        for (const row of chunk) {
          if (!row.phoneE164) {
            skipped++;
            continue;
          }
          const metadata = JSON.stringify({
            optedOut: false,
            country: row.country,
            tags: row.tags ?? []
          });
          const res = await client.query<{ id: string; xmax: string }>(
            `INSERT INTO contacts (tenant_id, phone_e164, first_name, last_name, timezone, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (tenant_id, phone_e164) DO UPDATE
               SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
                   last_name  = COALESCE(EXCLUDED.last_name,  contacts.last_name),
                   timezone   = COALESCE(EXCLUDED.timezone,   contacts.timezone),
                   metadata   = jsonb_set(
                                  jsonb_set(
                                    contacts.metadata,
                                    '{tags}',
                                    COALESCE(EXCLUDED.metadata->'tags', contacts.metadata->'tags', '[]'::jsonb)
                                  ),
                                  '{country}',
                                  COALESCE(EXCLUDED.metadata->'country', contacts.metadata->'country', 'null'::jsonb)
                                )
             RETURNING id, xmax::text`,
            [tenantId, row.phoneE164, row.firstName ?? null, row.lastName ?? null, row.timezone ?? null, metadata]
          );
          const upserted = res.rows[0]!;
          const wasInsert = upserted.xmax === "0";
          if (wasInsert) {
            created++;
          } else {
            updated++;
          }
          if (row.grantConsent) {
            await client.query(
              `INSERT INTO consent_records (tenant_id, contact_id, channel, source, policy_version, granted_at)
               VALUES ($1, $2, 'whatsapp', 'csv_import', 'v1', now())
               ON CONFLICT DO NOTHING`,
              [tenantId, upserted.id]
            );
          }
        }
      });
    }
    return { created, updated, skipped };
  }
};

interface TagRow {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  created_at: Date;
}

function mapTag(row: TagRow): Tag {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    color: row.color ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

export const tagRepository = {
  async create(tenantId: string, input: { name: string; color?: string }): Promise<Tag> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TagRow>(
        `INSERT INTO tags (tenant_id, name, color)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, name, color, created_at`,
        [tenantId, input.name, input.color ?? null]
      );
      return mapTag(result.rows[0]!);
    });
  },
  /** Idempotent tag creation keyed on (tenant, name); returns the existing or new tag. */
  async ensure(tenantId: string, name: string, color?: string): Promise<Tag> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TagRow>(
        `INSERT INTO tags (tenant_id, name, color)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, name) DO UPDATE SET color = COALESCE(EXCLUDED.color, tags.color)
         RETURNING id, tenant_id, name, color, created_at`,
        [tenantId, name, color ?? null]
      );
      return mapTag(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<Tag[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TagRow>("SELECT id, tenant_id, name, color, created_at FROM tags ORDER BY name");
      return result.rows.map(mapTag);
    });
  }
};

interface ContactNoteRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  author_user_id: string | null;
  note: string;
  created_at: Date;
}

function mapContactNote(row: ContactNoteRow): ContactNote {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    authorUserId: row.author_user_id ?? undefined,
    note: row.note,
    createdAt: row.created_at.toISOString()
  };
}

export const contactNoteRepository = {
  async add(tenantId: string, input: { contactId: string; authorUserId?: string; note: string }): Promise<ContactNote> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactNoteRow>(
        `INSERT INTO contact_notes (tenant_id, contact_id, author_user_id, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, contact_id, author_user_id, note, created_at`,
        [tenantId, input.contactId, input.authorUserId ?? null, input.note]
      );
      return mapContactNote(result.rows[0]!);
    });
  },
  async list(tenantId: string, contactId: string): Promise<ContactNote[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactNoteRow>(
        `SELECT id, tenant_id, contact_id, author_user_id, note, created_at
         FROM contact_notes WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [contactId]
      );
      return result.rows.map(mapContactNote);
    });
  }
};

export const consentRepository = {
  async grant(tenantId: string, contactId: string, input: { source: string; policyVersion: string }): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO consent_records (tenant_id, contact_id, channel, source, policy_version, granted_at)
         SELECT $1, $2, 'whatsapp', $3, $4, now()
         WHERE NOT EXISTS (
           SELECT 1 FROM consent_records
           WHERE contact_id = $2 AND channel = 'whatsapp' AND revoked_at IS NULL
         )`,
        [tenantId, contactId, input.source, input.policyVersion]
      );
    });
  },
  async revoke(tenantId: string, contactId: string, reason: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE consent_records SET revoked_at = now(), revoked_reason = $2
         WHERE contact_id = $1 AND revoked_at IS NULL`,
        [contactId, reason]
      );
    });
  },
  /** A contact has active consent if it has at least one un-revoked consent record. */
  async hasActiveConsent(tenantId: string, contactId: string): Promise<boolean> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        "SELECT 1 FROM consent_records WHERE contact_id = $1 AND revoked_at IS NULL LIMIT 1",
        [contactId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  },
  /** Batch check: returns the Set of contactIds that have at least one active consent record. */
  async hasConsentBatch(tenantId: string, contactIds: string[]): Promise<Set<string>> {
    if (contactIds.length === 0) return new Set();
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ contact_id: string }>(
        `SELECT DISTINCT contact_id FROM consent_records
         WHERE contact_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [contactIds]
      );
      return new Set(result.rows.map((r) => r.contact_id));
    });
  }
};

interface OrderRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  external_order_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: Date;
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    externalOrderId: row.external_order_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status as Order["status"],
    createdAt: row.created_at.toISOString()
  };
}

export const orderRepository = {
  async create(
    tenantId: string,
    input: { contactId: string; externalOrderId: string; amountMinor: number; currency: string }
  ): Promise<Order> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<OrderRow>(
        `INSERT INTO orders (tenant_id, contact_id, external_order_id, amount_minor, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'created')
         RETURNING id, tenant_id, contact_id, external_order_id, amount_minor, currency, status, created_at`,
        [tenantId, input.contactId, input.externalOrderId, input.amountMinor, input.currency]
      );
      return mapOrder(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<Order[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<OrderRow>(
        `SELECT id, tenant_id, contact_id, external_order_id, amount_minor, currency, status, created_at
         FROM orders ORDER BY created_at DESC`
      );
      return result.rows.map(mapOrder);
    });
  }
};

interface AuditRow {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    payload: row.payload,
    createdAt: row.created_at.toISOString()
  };
}

export const auditRepository = {
  async add(
    tenantId: string,
    event: {
      actorId?: string;
      action: string;
      resourceType: string;
      resourceId?: string;
      payload: Record<string, unknown>;
    }
  ): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          tenantId,
          event.actorId ?? null,
          event.action,
          event.resourceType,
          event.resourceId ?? null,
          JSON.stringify(event.payload)
        ]
      );
    });
  },
  async list(tenantId: string, page?: { limit: number; offset: number }): Promise<AuditEvent[]> {
    const limit = Math.min(page?.limit ?? 50, 200);
    const offset = page?.offset ?? 0;
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AuditRow>(
        `SELECT id, tenant_id, actor_id, action, resource_type, resource_id, payload, created_at
         FROM audit_events ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows.map(mapAudit);
    });
  }
};

interface ConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  assigned_user_id: string | null;
  state: string;
  contact_name: string | null;
  contact_phone: string | null;
  last_message: string | null;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    channelId: row.channel_id,
    contactName: row.contact_name ?? undefined,
    contactPhone: row.contact_phone ?? undefined,
    lastMessage: row.last_message ?? undefined,
    lastMessageAt: row.last_message_at?.toISOString(),
    lastInboundAt: row.last_inbound_at?.toISOString(),
    assignedUserId: row.assigned_user_id ?? undefined,
    state: (row.state ?? "open") as Conversation["state"]
  };
}

const CONV_SELECT = `
  SELECT c.id, c.tenant_id, c.contact_id, c.channel_id,
         c.last_message_at, c.last_inbound_at, c.assigned_user_id, c.state,
         NULLIF(TRIM(CONCAT_WS(' ', co.first_name, co.last_name)), '') AS contact_name,
         co.phone_e164 AS contact_phone,
         (SELECT m.payload->>'text'
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1) AS last_message
  FROM conversations c
  LEFT JOIN contacts co ON co.id = c.contact_id`;

export const conversationRepository = {
  async list(
    tenantId: string,
    opts?: { state?: string; assignedUserId?: string; limit?: number; offset?: number }
  ): Promise<{ items: Conversation[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (opts?.state) {
        params.push(opts.state);
        conditions.push(`c.state = $${params.length}`);
      }
      if (opts?.assignedUserId) {
        params.push(opts.assignedUserId);
        conditions.push(`c.assigned_user_id = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const totalResult = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM conversations ${where}`,
        params
      );
      const result = await client.query<ConversationRow>(
        `${CONV_SELECT} ${where} ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { items: result.rows.map(mapConversation), total: Number(totalResult.rows[0]?.total ?? "0") };
    });
  },
  async getById(tenantId: string, id: string): Promise<Conversation | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ConversationRow>(`${CONV_SELECT} WHERE c.id = $1`, [id]);
      return result.rows[0] ? mapConversation(result.rows[0]) : undefined;
    });
  },
  async findOrCreate(tenantId: string, contactId: string, channelId: string): Promise<Conversation> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query<ConversationRow>(
        `${CONV_SELECT} WHERE c.contact_id = $1 AND c.channel_id = $2 LIMIT 1`,
        [contactId, channelId]
      );
      if (existing.rows[0]) {
        return mapConversation(existing.rows[0]);
      }
      const insertedId = await client.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, contact_id, channel_id, state)
         VALUES ($1, $2, $3, 'open')
         RETURNING id`,
        [tenantId, contactId, channelId]
      );
      const inserted = await client.query<ConversationRow>(
        `${CONV_SELECT} WHERE c.id = $1`,
        [insertedId.rows[0]!.id]
      );
      return mapConversation(inserted.rows[0]!);
    });
  },
  async touchInbound(tenantId: string, conversationId: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE conversations SET last_inbound_at = now(), last_message_at = now() WHERE id = $1", [
        conversationId
      ]);
    });
  },
  async assign(tenantId: string, conversationId: string, userId: string | null): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE conversations SET assigned_user_id = $2 WHERE id = $1", [conversationId, userId]);
    });
  },
  async assignTeam(tenantId: string, conversationId: string, teamId: string | null): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE conversations SET assigned_team_id = $2 WHERE id = $1", [conversationId, teamId]);
    });
  },
  async setState(tenantId: string, conversationId: string, state: "open" | "pending" | "closed"): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE conversations SET state = $2 WHERE id = $1", [conversationId, state]);
    });
  },
  /** Returns the timestamp of the last inbound message for a contact across all channels (for 24h window check). */
  async lastInboundAt(tenantId: string, contactId: string): Promise<Date | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ last_inbound_at: Date | null }>(
        "SELECT MAX(last_inbound_at) AS last_inbound_at FROM conversations WHERE contact_id = $1",
        [contactId]
      );
      return result.rows[0]?.last_inbound_at ?? undefined;
    });
  },
  /** Batch variant: returns a Map of contactId → most-recent last_inbound_at. */
  async lastInboundAtBatch(tenantId: string, contactIds: string[]): Promise<Map<string, Date>> {
    if (contactIds.length === 0) return new Map();
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ contact_id: string; last_inbound_at: Date | null }>(
        `SELECT contact_id, MAX(last_inbound_at) AS last_inbound_at
         FROM conversations
         WHERE contact_id = ANY($1::uuid[])
         GROUP BY contact_id`,
        [contactIds]
      );
      const out = new Map<string, Date>();
      for (const row of result.rows) {
        if (row.last_inbound_at) out.set(row.contact_id, row.last_inbound_at);
      }
      return out;
    });
  }
};

interface ConversationNoteRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  author_user_id: string | null;
  note: string;
  created_at: Date;
}

function mapConversationNote(row: ConversationNoteRow): ConversationNote {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    authorUserId: row.author_user_id ?? undefined,
    note: row.note,
    createdAt: row.created_at.toISOString()
  };
}

export const conversationNoteRepository = {
  async add(
    tenantId: string,
    input: { conversationId: string; authorUserId?: string; note: string }
  ): Promise<ConversationNote> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ConversationNoteRow>(
        `INSERT INTO conversation_notes (tenant_id, conversation_id, author_user_id, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, conversation_id, author_user_id, note, created_at`,
        [tenantId, input.conversationId, input.authorUserId ?? null, input.note]
      );
      return mapConversationNote(result.rows[0]!);
    });
  },
  async list(tenantId: string, conversationId: string): Promise<ConversationNote[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ConversationNoteRow>(
        `SELECT id, tenant_id, conversation_id, author_user_id, note, created_at
         FROM conversation_notes WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [conversationId]
      );
      return result.rows.map(mapConversationNote);
    });
  }
};

interface MessageRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  direction: string;
  category: string | null;
  external_message_id: string | null;
  status: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    direction: row.direction as Message["direction"],
    category: (row.category as MessageCategory) ?? undefined,
    externalMessageId: row.external_message_id ?? undefined,
    status: row.status as Message["status"],
    payload: row.payload,
    createdAt: row.created_at.toISOString()
  };
}

export const messageRepository = {
  async create(
    tenantId: string,
    input: {
      conversationId: string;
      direction: Message["direction"];
      status: Message["status"];
      payload: Record<string, unknown>;
      category?: MessageCategory;
      externalMessageId?: string;
    }
  ): Promise<Message> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<MessageRow>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, category, external_message_id, payload, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id, tenant_id, conversation_id, direction, category, external_message_id, payload, status, created_at`,
        [
          tenantId,
          input.conversationId,
          input.direction,
          input.category ?? null,
          input.externalMessageId ?? null,
          JSON.stringify(input.payload),
          input.status
        ]
      );
      await client.query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [input.conversationId]);
      return mapMessage(result.rows[0]!);
    });
  },
  async updateStatusByExternalId(
    tenantId: string,
    externalMessageId: string,
    status: Message["status"]
  ): Promise<boolean> {
    return this.applyStatusUpdate(tenantId, externalMessageId, status);
  },
  /**
   * Transitions a message's status by Meta message id and merges delivery
   * metadata (pricing / conversation / error) into its JSONB payload.
   */
  async applyStatusUpdate(
    tenantId: string,
    externalMessageId: string,
    status: Message["status"],
    metaPatch?: Record<string, unknown>
  ): Promise<boolean> {
    return withTenant(tenantId, async (client) => {
      const patch = metaPatch && Object.keys(metaPatch).length > 0 ? JSON.stringify(metaPatch) : null;
      const result = await client.query(
        `UPDATE messages
         SET status = $2,
             payload = CASE WHEN $3::jsonb IS NULL THEN payload ELSE payload || $3::jsonb END
         WHERE external_message_id = $1`,
        [externalMessageId, status, patch]
      );
      return (result.rowCount ?? 0) > 0;
    });
  },
  async listByConversation(
    tenantId: string,
    conversationId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<Message[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return withTenant(tenantId, async (client) => {
      const params: unknown[] = [conversationId];
      let where = "conversation_id = $1";
      if (options.before) {
        params.push(options.before);
        where += ` AND created_at < $${params.length}`;
      }
      params.push(limit);
      const result = await client.query<MessageRow>(
        `SELECT id, tenant_id, conversation_id, direction, category, external_message_id, payload, status, created_at
         FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      // Return chronological (oldest first) for natural thread rendering.
      return result.rows.map(mapMessage).reverse();
    });
  },
  /**
   * Count outbound messages sent to a contact within a given time window.
   * Used for server-side frequency-cap enforcement.
   */
  async findByExternalId(tenantId: string, externalMessageId: string): Promise<Message | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<MessageRow>(
        `SELECT id, tenant_id, conversation_id, direction, category, external_message_id, payload, status, created_at
         FROM messages WHERE external_message_id = $1 LIMIT 1`,
        [externalMessageId]
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    });
  },
  async countOutboundSince(tenantId: string, contactId: string, sinceISO: string): Promise<number> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.contact_id = $1
           AND m.direction = 'outbound'
           AND m.created_at >= $2::timestamptz`,
        [contactId, sinceISO]
      );
      return Number(result.rows[0]?.count ?? "0");
    });
  },
  /** Batch variant: returns a Map of contactId → outbound message count since sinceISO. */
  async countOutboundSinceBatch(
    tenantId: string,
    contactIds: string[],
    sinceISO: string
  ): Promise<Map<string, number>> {
    if (contactIds.length === 0) return new Map();
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ contact_id: string; count: string }>(
        `SELECT c.contact_id, COUNT(*)::text AS count
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.contact_id = ANY($1::uuid[])
           AND m.direction = 'outbound'
           AND m.created_at >= $2::timestamptz
         GROUP BY c.contact_id`,
        [contactIds, sinceISO]
      );
      return new Map(result.rows.map((r) => [r.contact_id, Number(r.count)]));
    });
  }
};

export interface OutboxEnqueueInput {
  topic: string;
  payload: Record<string, unknown>;
}

export interface OutboxRow {
  id: string;
  tenant_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: Date;
}

export const outboxRepository = {
  /** Enqueue an event in the SAME transaction as the domain change (atomic). */
  async enqueue(client: QueryClient, tenantId: string, input: OutboxEnqueueInput): Promise<void> {
    await client.query(
      "INSERT INTO outbox_events (tenant_id, topic, payload, status) VALUES ($1, $2, $3::jsonb, 'pending')",
      [tenantId, input.topic, JSON.stringify(input.payload)]
    );
  },
  /** Batch-enqueue multiple events in one statement (still within the caller's transaction). */
  async enqueueBatch(client: QueryClient, tenantId: string, inputs: OutboxEnqueueInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const topics = inputs.map((i) => i.topic);
    const payloads = inputs.map((i) => JSON.stringify(i.payload));
    await client.query(
      `INSERT INTO outbox_events (tenant_id, topic, payload, status)
       SELECT $1, t, p::jsonb, 'pending'
       FROM unnest($2::text[], $3::text[]) AS u(t, p)`,
      [tenantId, topics, payloads]
    );
  },
  /** Claim a batch of pending/stuck rows for publishing (bypasses RLS via SECURITY DEFINER fn). */
  async claim(limit: number): Promise<OutboxRow[]> {
    const result = await query<OutboxRow>("SELECT * FROM outbox_claim($1)", [limit]);
    return result.rows;
  },
  async markProcessed(id: string): Promise<void> {
    await query("SELECT outbox_mark_processed($1)", [id]);
  }
};

export const campaignSendLog = {
  /** Returns true if this (campaign, phone) was newly claimed; false if already sent. */
  async tryClaim(tenantId: string, campaignId: string, phoneE164: string): Promise<boolean> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO campaign_send_log (tenant_id, campaign_id, phone_e164)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, campaignId, phoneE164]
      );
      return (result.rowCount ?? 0) > 0;
    });
  },
  /** Releases a claim so a failed send can be retried on redelivery. */
  async release(tenantId: string, campaignId: string, phoneE164: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("DELETE FROM campaign_send_log WHERE campaign_id = $1 AND phone_e164 = $2", [
        campaignId,
        phoneE164
      ]);
    });
  }
};

export interface ResolvedChannel {
  tenantId: string;
  channelId: string;
}

/** System-level lookup (no tenant context) used by the inbound webhook consumer. Cached for 5 min. */
export async function resolveChannelByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | undefined> {
  const cached = resolvedByPhoneNumberIdCache.get(phoneNumberId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const result = await query<{ tenant_id: string; channel_id: string }>(
    "SELECT tenant_id, channel_id FROM resolve_channel_by_phone_number_id($1)",
    [phoneNumberId]
  );
  const row = result.rows[0];
  const resolved = row ? { tenantId: row.tenant_id, channelId: row.channel_id } : undefined;
  resolvedByPhoneNumberIdCache.set(phoneNumberId, { value: resolved, expiresAt: Date.now() + CHANNEL_CREDS_TTL_MS });
  return resolved;
}

export interface TenantAnalytics {
  templates: number;
  campaigns: number;
  contacts: number;
  conversations: number;
  optOutRate: number;
  campaignStats?: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    policySkipped: number;
  };
}

export async function tenantAnalytics(
  tenantId: string,
  opts: { campaignId?: string } = {}
): Promise<TenantAnalytics> {
  return withTenant(tenantId, async (client) => {
    const [templates, campaigns, contacts, conversations] = await Promise.all([
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM templates"),
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM campaigns"),
      client.query<{ total: string; opted_out: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE metadata->>'optedOut' = 'true')::text AS opted_out
         FROM contacts`
      ),
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM conversations")
    ]);
    const total = Number(contacts.rows[0]?.total ?? "0");
    const optedOut = Number(contacts.rows[0]?.opted_out ?? "0");

    const campaignStatsResult = opts.campaignId
      ? await client.query<{ status: string; count: string }>(
          `SELECT status, COUNT(*)::text AS count
           FROM campaign_recipients
           WHERE campaign_id = $1
           GROUP BY status`,
          [opts.campaignId]
        )
      : null;

    let campaignStats: TenantAnalytics["campaignStats"];
    if (campaignStatsResult) {
      const byStatus = new Map<string, number>();
      for (const row of campaignStatsResult.rows) {
        byStatus.set(row.status, Number(row.count));
      }
      campaignStats = {
        sent: byStatus.get("sent") ?? 0,
        delivered: byStatus.get("delivered") ?? 0,
        read: byStatus.get("read") ?? 0,
        failed: byStatus.get("failed") ?? 0,
        policySkipped: byStatus.get("policy_skipped") ?? 0
      };
    }

    return {
      templates: Number(templates.rows[0]?.count ?? "0"),
      campaigns: Number(campaigns.rows[0]?.count ?? "0"),
      contacts: total,
      conversations: Number(conversations.rows[0]?.count ?? "0"),
      optOutRate: total ? Number((optedOut / total).toFixed(4)) : 0,
      ...(campaignStats !== undefined ? { campaignStats } : {})
    };
  });
}

// ─── Segments ──────────────────────────────────────────────────────────────────

interface SegmentRow {
  id: string;
  tenant_id: string;
  name: string;
  definition: Segment["definition"];
  created_at: Date;
}

function mapSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    definition: row.definition ?? {},
    createdAt: row.created_at.toISOString()
  };
}

export const segmentRepository = {
  async create(tenantId: string, input: { name: string; definition: Segment["definition"] }): Promise<Segment> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<SegmentRow>(
        `INSERT INTO segments (tenant_id, name, definition)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, tenant_id, name, definition, created_at`,
        [tenantId, input.name, JSON.stringify(input.definition)]
      );
      return mapSegment(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<Segment[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<SegmentRow>(
        "SELECT id, tenant_id, name, definition, created_at FROM segments ORDER BY created_at DESC"
      );
      return result.rows.map(mapSegment);
    });
  },
  async getById(tenantId: string, id: string): Promise<Segment | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<SegmentRow>(
        "SELECT id, tenant_id, name, definition, created_at FROM segments WHERE id = $1",
        [id]
      );
      return result.rows[0] ? mapSegment(result.rows[0]) : undefined;
    });
  },
  /**
   * Resolves contacts matching a segment definition.
   * Returns lightweight rows suitable for fan-out (id, phone_e164).
   */
  async resolveContacts(
    tenantId: string,
    definition: Segment["definition"]
  ): Promise<Array<{ id: string; phoneE164: string; firstName?: string; lastName?: string; timezone?: string }>> {
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = ["(c.metadata->>'optedOut')::boolean IS NOT TRUE"];
      const params: unknown[] = [];

      if (definition.country) {
        params.push(definition.country);
        conditions.push(`c.metadata->>'country' = $${params.length}`);
      }
      if (definition.tags && definition.tags.length > 0) {
        params.push(JSON.stringify(definition.tags));
        conditions.push(`c.metadata->'tags' @> $${params.length}::jsonb`);
      }

      let join = "";
      if (definition.hasConsent !== false) {
        join = "JOIN consent_records cr ON cr.contact_id = c.id AND cr.revoked_at IS NULL";
        // Deduplicate contacts with multiple consent records.
        conditions.push("TRUE");
      }

      const where = conditions.join(" AND ");
      const sql = `
        SELECT DISTINCT ON (c.id) c.id, c.phone_e164, c.first_name, c.last_name, c.timezone
        FROM contacts c
        ${join}
        WHERE ${where}
        ORDER BY c.id`;

      const result = await client.query<{
        id: string;
        phone_e164: string;
        first_name: string | null;
        last_name: string | null;
        timezone: string | null;
      }>(sql, params);

      return result.rows.map((r) => ({
        id: r.id,
        phoneE164: r.phone_e164,
        firstName: r.first_name ?? undefined,
        lastName: r.last_name ?? undefined,
        timezone: r.timezone ?? undefined
      }));
    });
  },
  async previewCount(tenantId: string, definition: Segment["definition"]): Promise<number> {
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = ["(c.metadata->>'optedOut')::boolean IS NOT TRUE"];
      const params: unknown[] = [];

      if (definition.country) {
        params.push(definition.country);
        conditions.push(`c.metadata->>'country' = $${params.length}`);
      }
      if (definition.tags && definition.tags.length > 0) {
        params.push(JSON.stringify(definition.tags));
        conditions.push(`c.metadata->'tags' @> $${params.length}::jsonb`);
      }

      let join = "";
      if (definition.hasConsent !== false) {
        join = "JOIN consent_records cr ON cr.contact_id = c.id AND cr.revoked_at IS NULL";
      }

      const where = conditions.join(" AND ");
      const sql = `
        SELECT COUNT(DISTINCT c.id) AS cnt
        FROM contacts c
        ${join}
        WHERE ${where}`;

      const result = await client.query<{ cnt: string }>(sql, params);
      return Number(result.rows[0]?.cnt ?? 0);
    });
  },

  async resolveContactsSample(
    tenantId: string,
    definition: Segment["definition"],
    limit: number
  ): Promise<Array<{ id: string; phoneE164: string; firstName?: string; lastName?: string; timezone?: string }>> {
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = ["(c.metadata->>'optedOut')::boolean IS NOT TRUE"];
      const params: unknown[] = [];

      if (definition.country) {
        params.push(definition.country);
        conditions.push(`c.metadata->>'country' = $${params.length}`);
      }
      if (definition.tags && definition.tags.length > 0) {
        params.push(JSON.stringify(definition.tags));
        conditions.push(`c.metadata->'tags' @> $${params.length}::jsonb`);
      }

      let join = "";
      if (definition.hasConsent !== false) {
        join = "JOIN consent_records cr ON cr.contact_id = c.id AND cr.revoked_at IS NULL";
      }

      params.push(limit);
      const where = conditions.join(" AND ");
      const sql = `
        SELECT DISTINCT ON (c.id) c.id, c.phone_e164, c.first_name, c.last_name, c.timezone
        FROM contacts c
        ${join}
        WHERE ${where}
        ORDER BY c.id
        LIMIT $${params.length}`;

      const result = await client.query<{
        id: string;
        phone_e164: string;
        first_name: string | null;
        last_name: string | null;
        timezone: string | null;
      }>(sql, params);

      return result.rows.map((r) => ({
        id: r.id,
        phoneE164: r.phone_e164,
        firstName: r.first_name ?? undefined,
        lastName: r.last_name ?? undefined,
        timezone: r.timezone ?? undefined
      }));
    });
  }
};

// ─── Campaign recipients ────────────────────────────────────────────────────────

interface CampaignRecipientRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  contact_id: string;
  phone_e164: string;
  status: string;
  external_message_id: string | null;
  error: string | null;
  skip_reason: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  created_at: Date;
}

function mapRecipient(row: CampaignRecipientRow): CampaignRecipient {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    phoneE164: row.phone_e164,
    status: row.status as CampaignRecipient["status"],
    externalMessageId: row.external_message_id ?? undefined,
    error: row.error ?? undefined,
    skipReason: row.skip_reason ?? undefined,
    sentAt: row.sent_at?.toISOString(),
    deliveredAt: row.delivered_at?.toISOString(),
    readAt: row.read_at?.toISOString(),
    createdAt: row.created_at.toISOString()
  };
}

export const campaignRecipientRepository = {
  /** Bulk-insert recipient rows (pending status) for a new campaign run. */
  async insertBatch(
    tenantId: string,
    campaignId: string,
    contacts: Array<{ id: string; phoneE164: string }>
  ): Promise<void> {
    if (contacts.length === 0) return;
    const CHUNK = 200;
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const chunk = contacts.slice(i, i + CHUNK);
      await withTenant(tenantId, async (client) => {
        for (const c of chunk) {
          await client.query(
            `INSERT INTO campaign_recipients (tenant_id, campaign_id, contact_id, phone_e164, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
            [tenantId, campaignId, c.id, c.phoneE164]
          );
        }
      });
    }
  },
  async updateStatus(
    tenantId: string,
    recipientId: string,
    update: {
      status: CampaignRecipient["status"];
      externalMessageId?: string;
      error?: string;
      skipReason?: string;
    }
  ): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE campaign_recipients
         SET status = $2,
             external_message_id = COALESCE($3, external_message_id),
             error = $4,
             skip_reason = $5,
             sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
         WHERE id = $1`,
        [recipientId, update.status, update.externalMessageId ?? null, update.error ?? null, update.skipReason ?? null]
      );
    });
  },
  async updateByExternalMessageId(
    tenantId: string,
    externalMessageId: string,
    status: "delivered" | "read" | "failed",
    error?: string
  ): Promise<{ campaignId: string | undefined }> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ campaign_id: string }>(
        `UPDATE campaign_recipients
         SET status = $2,
             error = $3,
             delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
             read_at      = CASE WHEN $2 = 'read'      THEN now() ELSE read_at      END
         WHERE external_message_id = $1
         RETURNING campaign_id`,
        [externalMessageId, status, error ?? null]
      );
      return { campaignId: result.rows[0]?.campaign_id };
    });
  },
  async listByCampaign(
    tenantId: string,
    campaignId: string,
    opts?: { limit?: number; status?: string }
  ): Promise<CampaignRecipient[]> {
    const limit = Math.min(opts?.limit ?? 200, 1000);
    return withTenant(tenantId, async (client) => {
      const params: unknown[] = [campaignId];
      let where = "campaign_id = $1";
      if (opts?.status) {
        params.push(opts.status);
        where += ` AND status = $${params.length}`;
      }
      params.push(limit);
      const result = await client.query<CampaignRecipientRow>(
        `SELECT id, tenant_id, campaign_id, contact_id, phone_e164, status,
                external_message_id, error, skip_reason, sent_at, delivered_at, read_at, created_at
         FROM campaign_recipients WHERE ${where}
         ORDER BY created_at ASC LIMIT $${params.length}`,
        params
      );
      return result.rows.map(mapRecipient);
    });
  },
  async listRecipients(
    tenantId: string,
    campaignId: string,
    opts: { offset?: number; limit?: number } = {}
  ): Promise<{ items: CampaignRecipient[]; total: number }> {
    return withTenant(tenantId, async (client) => {
      const limit = opts.limit ?? 100;
      const offset = opts.offset ?? 0;
      const [rows, countRow] = await Promise.all([
        client.query<CampaignRecipientRow>(
          `SELECT id, tenant_id, campaign_id, contact_id, phone_e164, status,
                  external_message_id, error, skip_reason, sent_at, delivered_at, read_at, created_at
           FROM campaign_recipients
           WHERE campaign_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [campaignId, limit, offset]
        ),
        client.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM campaign_recipients WHERE campaign_id = $1`,
          [campaignId]
        )
      ]);
      return {
        items: rows.rows.map(mapRecipient),
        total: Number(countRow.rows[0]?.total ?? "0")
      };
    });
  },
  async funnelCounts(tenantId: string, campaignId: string): Promise<Record<string, number>> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count
         FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
        [campaignId]
      );
      const counts: Record<string, number> = {};
      for (const row of result.rows) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    });
  },
  /** Returns next batch of pending recipients to fan-out (cursor-based pagination). */
  async claimPendingBatch(tenantId: string, campaignId: string, batchSize: number): Promise<CampaignRecipient[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<CampaignRecipientRow>(
        `SELECT id, tenant_id, campaign_id, contact_id, phone_e164, status,
                external_message_id, error, skip_reason, sent_at, delivered_at, read_at, created_at
         FROM campaign_recipients
         WHERE campaign_id = $1 AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [campaignId, batchSize]
      );
      return result.rows.map(mapRecipient);
    });
  }
};

// ─── Auto-reply rules ──────────────────────────────────────────────────────────

interface AutoReplyRuleRow {
  id: string;
  tenant_id: string;
  match_type: string;
  keyword: string | null;
  reply_kind: string;
  reply_text: string | null;
  enabled: boolean;
  priority: number;
  created_at: Date;
}

function mapAutoReplyRule(row: AutoReplyRuleRow): AutoReplyRule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    matchType: row.match_type as AutoReplyRule["matchType"],
    keyword: row.keyword ?? undefined,
    replyKind: row.reply_kind as AutoReplyRule["replyKind"],
    replyText: row.reply_text ?? undefined,
    enabled: row.enabled,
    priority: row.priority,
    createdAt: row.created_at.toISOString()
  };
}

export const autoReplyRuleRepository = {
  async create(
    tenantId: string,
    input: {
      matchType?: AutoReplyRule["matchType"];
      keyword?: string;
      replyKind?: AutoReplyRule["replyKind"];
      replyText?: string;
      enabled?: boolean;
      priority?: number;
    }
  ): Promise<AutoReplyRule> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AutoReplyRuleRow>(
        `INSERT INTO auto_reply_rules (tenant_id, match_type, keyword, reply_kind, reply_text, enabled, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_id, match_type, keyword, reply_kind, reply_text, enabled, priority, created_at`,
        [
          tenantId,
          input.matchType ?? "keyword",
          input.keyword ?? null,
          input.replyKind ?? "text",
          input.replyText ?? null,
          input.enabled ?? true,
          input.priority ?? 0
        ]
      );
      return mapAutoReplyRule(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<AutoReplyRule[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AutoReplyRuleRow>(
        "SELECT id, tenant_id, match_type, keyword, reply_kind, reply_text, enabled, priority, created_at FROM auto_reply_rules ORDER BY priority DESC, created_at ASC"
      );
      return result.rows.map(mapAutoReplyRule);
    });
  },
  async listEnabled(tenantId: string): Promise<AutoReplyRule[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AutoReplyRuleRow>(
        "SELECT id, tenant_id, match_type, keyword, reply_kind, reply_text, enabled, priority, created_at FROM auto_reply_rules WHERE enabled = true AND tenant_id::text = current_setting('app.tenant_id', true) ORDER BY priority DESC, created_at ASC"
      );
      return result.rows.map(mapAutoReplyRule);
    });
  },
  async setEnabled(tenantId: string, id: string, enabled: boolean): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE auto_reply_rules SET enabled = $2 WHERE id = $1", [id, enabled]);
    });
  }
};

// ─── Saved replies ──────────────────────────────────────────────────────────────

interface SavedReplyRow {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  created_at: Date;
}

function mapSavedReply(row: SavedReplyRow): SavedReply {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString()
  };
}

export const savedReplyRepository = {
  async create(tenantId: string, input: { title: string; body: string }): Promise<SavedReply> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<SavedReplyRow>(
        `INSERT INTO saved_replies (tenant_id, title, body)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, title) DO UPDATE SET body = EXCLUDED.body
         RETURNING id, tenant_id, title, body, created_at`,
        [tenantId, input.title, input.body]
      );
      return mapSavedReply(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<SavedReply[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<SavedReplyRow>(
        "SELECT id, tenant_id, title, body, created_at FROM saved_replies ORDER BY title ASC LIMIT 200"
      );
      return result.rows.map(mapSavedReply);
    });
  },
  async delete(tenantId: string, id: string): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("DELETE FROM saved_replies WHERE id = $1", [id]);
    });
  }
};

// ─── Automation rules ───────────────────────────────────────────────────────────

interface AutomationRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  trigger_type: string;
  conditions: AutomationConditions;
  action_type: string;
  action_config: AutomationActionConfig;
  enabled: boolean;
  priority: number;
  created_at: Date;
}

function mapAutomationRule(row: AutomationRuleRow): AutomationRule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    triggerType: row.trigger_type as AutomationRule["triggerType"],
    conditions: row.conditions ?? {},
    actionType: row.action_type as AutomationRule["actionType"],
    actionConfig: row.action_config ?? {},
    enabled: row.enabled,
    priority: row.priority,
    createdAt: row.created_at.toISOString()
  };
}

const AUTOMATION_SELECT =
  "SELECT id, tenant_id, name, trigger_type, conditions, action_type, action_config, enabled, priority, created_at FROM automation_rules";

export const automationRuleRepository = {
  async create(
    tenantId: string,
    input: {
      name: string;
      triggerType: AutomationRule["triggerType"];
      conditions?: AutomationConditions;
      actionType: AutomationRule["actionType"];
      actionConfig?: AutomationActionConfig;
      enabled?: boolean;
      priority?: number;
    }
  ): Promise<AutomationRule> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AutomationRuleRow>(
        `INSERT INTO automation_rules (tenant_id, name, trigger_type, conditions, action_type, action_config, enabled, priority)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)
         RETURNING id, tenant_id, name, trigger_type, conditions, action_type, action_config, enabled, priority, created_at`,
        [
          tenantId,
          input.name,
          input.triggerType,
          JSON.stringify(input.conditions ?? {}),
          input.actionType,
          JSON.stringify(input.actionConfig ?? {}),
          input.enabled ?? true,
          input.priority ?? 0
        ]
      );
      return mapAutomationRule(result.rows[0]!);
    });
  },
  async list(
    tenantId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<{ items: AutomationRule[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    return withTenant(tenantId, async (client) => {
      const totalResult = await client.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM automation_rules WHERE tenant_id = current_setting('app.tenant_id', true)::uuid"
      );
      const result = await client.query<AutomationRuleRow>(
        `${AUTOMATION_SELECT} ORDER BY priority DESC, created_at ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return { items: result.rows.map(mapAutomationRule), total: Number(totalResult.rows[0]?.total ?? "0") };
    });
  },
  async listEnabledByTrigger(
    tenantId: string,
    triggerType: AutomationRule["triggerType"]
  ): Promise<AutomationRule[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AutomationRuleRow>(
        `${AUTOMATION_SELECT} WHERE enabled = true AND trigger_type = $1 AND tenant_id::text = current_setting('app.tenant_id', true) ORDER BY priority DESC, created_at ASC`,
        [triggerType]
      );
      return result.rows.map(mapAutomationRule);
    });
  },
  async setEnabled(tenantId: string, id: string, enabled: boolean): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE automation_rules SET enabled = $2 WHERE id = $1", [id, enabled]);
    });
  }
};

// ─── Tasks / reminders ──────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  tenant_id: string;
  title: string;
  status: string;
  contact_id: string | null;
  conversation_id: string | null;
  assignee_user_id: string | null;
  due_at: Date | null;
  remind_at: Date | null;
  source: string;
  created_at: Date;
  updated_at: Date;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    status: row.status as Task["status"],
    contactId: row.contact_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    assigneeUserId: row.assignee_user_id ?? undefined,
    dueAt: row.due_at?.toISOString(),
    remindAt: row.remind_at?.toISOString(),
    source: row.source,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const TASK_SELECT =
  "SELECT id, tenant_id, title, status, contact_id, conversation_id, assignee_user_id, due_at, remind_at, source, created_at, updated_at FROM tasks";

export const taskRepository = {
  async create(
    tenantId: string,
    input: {
      title: string;
      contactId?: string;
      conversationId?: string;
      assigneeUserId?: string;
      dueAt?: string;
      remindAt?: string;
      source?: string;
    }
  ): Promise<Task> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TaskRow>(
        `INSERT INTO tasks (tenant_id, title, contact_id, conversation_id, assignee_user_id, due_at, remind_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, tenant_id, title, status, contact_id, conversation_id, assignee_user_id, due_at, remind_at, source, created_at, updated_at`,
        [
          tenantId,
          input.title,
          input.contactId ?? null,
          input.conversationId ?? null,
          input.assigneeUserId ?? null,
          input.dueAt ?? null,
          input.remindAt ?? null,
          input.source ?? "manual"
        ]
      );
      return mapTask(result.rows[0]!);
    });
  },
  async list(
    tenantId: string,
    opts?: { status?: string; assigneeUserId?: string; limit?: number; offset?: number }
  ): Promise<{ items: Task[]; total: number }> {
    const limit = opts?.limit ?? 25;
    const offset = opts?.offset ?? 0;
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (opts?.status) {
        params.push(opts.status);
        conditions.push(`status = $${params.length}`);
      }
      if (opts?.assigneeUserId) {
        params.push(opts.assigneeUserId);
        conditions.push(`assignee_user_id = $${params.length}`);
      }
      const tenantFilter = "tenant_id = current_setting('app.tenant_id', true)::uuid";
      const where = conditions.length > 0 ? `WHERE ${tenantFilter} AND ${conditions.join(" AND ")}` : `WHERE ${tenantFilter}`;
      const totalResult = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM tasks ${where}`,
        params
      );
      const result = await client.query<TaskRow>(
        `${TASK_SELECT} ${where} ORDER BY (status = 'open') DESC, due_at ASC NULLS LAST, created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { items: result.rows.map(mapTask), total: Number(totalResult.rows[0]?.total ?? "0") };
    });
  },
  async updateStatus(tenantId: string, id: string, status: Task["status"]): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query("UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
    });
  }
};

export const contactImportRepository = {
  async create(
    tenantId: string,
    input: { filename?: string; total: number; created: number; updated: number; skipped: number }
  ): Promise<{ id: string }> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO contact_imports (tenant_id, filename, total, created_count, updated_count, skipped_count)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, input.filename ?? null, input.total, input.created, input.updated, input.skipped]
      );
      return { id: result.rows[0]!.id };
    });
  }
};

// ─── Link clicks ────────────────────────────────────────────────────────────────

export const linkClickRepository = {
  async create(
    tenantId: string,
    input: { token: string; destination: string; campaignId?: string; contactId?: string }
  ): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO link_clicks (tenant_id, token, destination, campaign_id, contact_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (token) DO NOTHING`,
        [tenantId, input.token, input.destination, input.campaignId ?? null, input.contactId ?? null]
      );
    });
  },
  async recordClick(token: string): Promise<{ destination: string; tenantId: string } | undefined> {
    const result = await query<{ destination: string; tenant_id: string }>(
      `UPDATE link_clicks
       SET clicked_count = clicked_count + 1,
           first_clicked_at = COALESCE(first_clicked_at, now()),
           last_clicked_at = now()
       WHERE token = $1
       RETURNING destination, tenant_id`,
      [token]
    );
    const row = result.rows[0];
    return row ? { destination: row.destination, tenantId: row.tenant_id } : undefined;
  },
  async list(
    tenantId: string,
    opts: { campaignId?: string; offset?: number; limit?: number } = {}
  ): Promise<{ items: Array<{ id: string; linkToken: string; campaignId?: string; contactId?: string; clickedAt?: string }>; total: number }> {
    return withTenant(tenantId, async (client) => {
      const conditions: string[] = ["tenant_id = current_setting('app.tenant_id', true)::uuid"];
      const params: unknown[] = [];
      if (opts.campaignId) {
        params.push(opts.campaignId);
        conditions.push(`campaign_id = $${params.length}`);
      }
      const limitVal = opts.limit ?? 100;
      const offsetVal = opts.offset ?? 0;
      params.push(limitVal);
      const limitIdx = params.length;
      params.push(offsetVal);
      const offsetIdx = params.length;
      const where = conditions.join(" AND ");
      // Use params without LIMIT/OFFSET for the count query
      const countParams = params.slice(0, params.length - 2);
      const [rows, countRow] = await Promise.all([
        client.query<{ id: string; token: string; campaign_id: string | null; contact_id: string | null; last_clicked_at: Date | null }>(
          `SELECT id, token, campaign_id, contact_id, last_clicked_at
           FROM link_clicks WHERE ${where}
           ORDER BY last_clicked_at DESC NULLS LAST
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params
        ),
        client.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM link_clicks WHERE ${where}`,
          countParams
        )
      ]);
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          linkToken: r.token,
          campaignId: r.campaign_id ?? undefined,
          contactId: r.contact_id ?? undefined,
          clickedAt: r.last_clicked_at?.toISOString()
        })),
        total: Number(countRow.rows[0]?.total ?? "0")
      };
    });
  }
};
