import { query, withTenant, type QueryClient } from "./db.js";
import type {
  AuditEvent,
  Campaign,
  Contact,
  Conversation,
  Message,
  MessageCategory,
  Order,
  Role,
  Template,
  Tenant,
  User,
  WhatsAppChannel
} from "@hyfib/shared-core";

export type CampaignWithTemplate = Campaign & {
  templateName: string;
  templateLanguage: string;
  sentCount: number;
  failedCount: number;
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
}

function mapChannel(row: ChannelRow): WhatsAppChannel {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    qualityRating: (row.quality_rating as WhatsAppChannel["qualityRating"]) ?? "unknown",
    status: row.is_active ? "active" : "inactive",
    createdAt: row.created_at.toISOString()
  };
}

export const channelRepository = {
  async create(
    tenantId: string,
    input: { wabaId: string; phoneNumberId: string; displayPhoneNumber: string }
  ): Promise<WhatsAppChannel> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelRow>(
        `INSERT INTO whatsapp_channels (tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active)
         VALUES ($1, $2, $3, $4, 'unknown', true)
         RETURNING id, tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active, created_at`,
        [tenantId, input.wabaId, input.phoneNumberId, input.displayPhoneNumber]
      );
      return mapChannel(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<WhatsAppChannel[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelRow>(
        `SELECT id, tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active, created_at
         FROM whatsapp_channels ORDER BY created_at DESC`
      );
      return result.rows.map(mapChannel);
    });
  },
  async firstActive(tenantId: string): Promise<WhatsAppChannel | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ChannelRow>(
        `SELECT id, tenant_id, waba_id, phone_number_id, display_phone_number, quality_rating, is_active, created_at
         FROM whatsapp_channels WHERE is_active = true ORDER BY created_at ASC LIMIT 1`
      );
      return result.rows[0] ? mapChannel(result.rows[0]) : undefined;
    });
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
  async list(tenantId: string): Promise<Template[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<TemplateRow>(
        "SELECT id, tenant_id, name, category, language, status, body FROM templates ORDER BY created_at DESC"
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
  sent_count: string | null;
  failed_count: string | null;
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
    sentCount: Number(row.sent_count ?? "0"),
    failedCount: Number(row.failed_count ?? "0")
  };
}

const CAMPAIGN_SELECT = `
  SELECT c.id, c.tenant_id, c.name, c.template_id, c.status, c.created_at,
         t.name AS template_name, t.language AS template_language, t.category AS template_category,
         s.sent_count, s.failed_count
  FROM campaigns c
  JOIN templates t ON t.id = c.template_id
  LEFT JOIN campaign_stats s ON s.campaign_id = c.id
`;

export const campaignRepository = {
  async create(tenantId: string, input: { name: string; templateId: string }): Promise<CampaignWithTemplate> {
    return withTenant(tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO campaigns (tenant_id, name, template_id, status) VALUES ($1, $2, $3, 'draft') RETURNING id",
        [tenantId, input.name, input.templateId]
      );
      const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [inserted.rows[0]!.id]);
      return mapCampaign(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<CampaignWithTemplate[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<CampaignRow>(`${CAMPAIGN_SELECT} ORDER BY c.created_at DESC`);
      return result.rows.map(mapCampaign);
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
  }
};

interface ContactRow {
  id: string;
  tenant_id: string;
  phone_e164: string;
  first_name: string | null;
  last_name: string | null;
  metadata: { optedOut?: boolean; country?: string; tags?: string[] };
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
    tags: row.metadata?.tags ?? []
  };
}

export const contactRepository = {
  async create(
    tenantId: string,
    input: { phoneE164: string; firstName?: string; lastName?: string; country?: string; tags?: string[] }
  ): Promise<Contact> {
    return withTenant(tenantId, async (client) => {
      const metadata = { optedOut: false, country: input.country, tags: input.tags ?? [] };
      const result = await client.query<ContactRow>(
        `INSERT INTO contacts (tenant_id, phone_e164, first_name, last_name, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, tenant_id, phone_e164, first_name, last_name, metadata`,
        [tenantId, input.phoneE164, input.firstName ?? null, input.lastName ?? null, JSON.stringify(metadata)]
      );
      return mapContact(result.rows[0]!);
    });
  },
  async list(tenantId: string): Promise<Contact[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(
        "SELECT id, tenant_id, phone_e164, first_name, last_name, metadata FROM contacts ORDER BY created_at DESC"
      );
      return result.rows.map(mapContact);
    });
  },
  async findByPhone(tenantId: string, phoneE164: string): Promise<Contact | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(
        "SELECT id, tenant_id, phone_e164, first_name, last_name, metadata FROM contacts WHERE phone_e164 = $1",
        [phoneE164]
      );
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
         RETURNING id, tenant_id, phone_e164, first_name, last_name, metadata`,
        [tenantId, phoneE164]
      );
      return mapContact(inserted.rows[0]!);
    });
  },
  async getById(tenantId: string, id: string): Promise<Contact | undefined> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ContactRow>(
        "SELECT id, tenant_id, phone_e164, first_name, last_name, metadata FROM contacts WHERE id = $1",
        [id]
      );
      return result.rows[0] ? mapContact(result.rows[0]) : undefined;
    });
  },
  async setOptedOut(tenantId: string, contactId: string, optedOut: boolean): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        "UPDATE contacts SET metadata = jsonb_set(metadata, '{optedOut}', to_jsonb($2::boolean)) WHERE id = $1",
        [contactId, optedOut]
      );
    });
  }
};

export const consentRepository = {
  async grant(tenantId: string, contactId: string, input: { source: string; policyVersion: string }): Promise<void> {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO consent_records (tenant_id, contact_id, channel, source, policy_version, granted_at)
         VALUES ($1, $2, 'whatsapp', $3, $4, now())`,
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
  async list(tenantId: string): Promise<AuditEvent[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<AuditRow>(
        `SELECT id, tenant_id, actor_id, action, resource_type, resource_id, payload, created_at
         FROM audit_events ORDER BY created_at DESC LIMIT 500`
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
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    channelId: row.channel_id,
    lastMessageAt: row.last_message_at?.toISOString()
  };
}

export const conversationRepository = {
  async list(tenantId: string): Promise<Conversation[]> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<ConversationRow>(
        `SELECT id, tenant_id, contact_id, channel_id, last_message_at
         FROM conversations ORDER BY last_message_at DESC NULLS LAST LIMIT 200`
      );
      return result.rows.map(mapConversation);
    });
  },
  async findOrCreate(tenantId: string, contactId: string, channelId: string): Promise<Conversation> {
    return withTenant(tenantId, async (client) => {
      const existing = await client.query<ConversationRow>(
        `SELECT id, tenant_id, contact_id, channel_id, last_message_at
         FROM conversations WHERE contact_id = $1 AND channel_id = $2 LIMIT 1`,
        [contactId, channelId]
      );
      if (existing.rows[0]) {
        return mapConversation(existing.rows[0]);
      }
      const inserted = await client.query<ConversationRow>(
        `INSERT INTO conversations (tenant_id, contact_id, channel_id)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, contact_id, channel_id, last_message_at`,
        [tenantId, contactId, channelId]
      );
      return mapConversation(inserted.rows[0]!);
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
    return withTenant(tenantId, async (client) => {
      const result = await client.query("UPDATE messages SET status = $2 WHERE external_message_id = $1", [
        externalMessageId,
        status
      ]);
      return (result.rowCount ?? 0) > 0;
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

/** System-level lookup (no tenant context) used by the inbound webhook consumer. */
export async function resolveChannelByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | undefined> {
  const result = await query<{ tenant_id: string; channel_id: string }>(
    "SELECT tenant_id, channel_id FROM resolve_channel_by_phone_number_id($1)",
    [phoneNumberId]
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, channelId: row.channel_id } : undefined;
}

export interface TenantAnalytics {
  templates: number;
  campaigns: number;
  contacts: number;
  optOutRate: number;
}

export async function tenantAnalytics(tenantId: string): Promise<TenantAnalytics> {
  return withTenant(tenantId, async (client) => {
    const [templates, campaigns, contacts] = await Promise.all([
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM templates"),
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM campaigns"),
      client.query<{ total: string; opted_out: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE metadata->>'optedOut' = 'true')::text AS opted_out
         FROM contacts`
      )
    ]);
    const total = Number(contacts.rows[0]?.total ?? "0");
    const optedOut = Number(contacts.rows[0]?.opted_out ?? "0");
    return {
      templates: Number(templates.rows[0]?.count ?? "0"),
      campaigns: Number(campaigns.rows[0]?.count ?? "0"),
      contacts: total,
      optOutRate: total ? Number((optedOut / total).toFixed(4)) : 0
    };
  });
}
