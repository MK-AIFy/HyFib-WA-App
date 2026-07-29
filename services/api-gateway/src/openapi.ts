/**
 * OpenAPI 3.1 description of the public HyFib API (roadmap Phase C). Served
 * at GET /api/v1/openapi.json. Hand-maintained next to the router it
 * describes; the structural test in test/openapi.test.js keeps it internally
 * consistent (every operation has a 2xx response, params typed, etc.).
 * Covers the stable v1 surface on main — endpoints landing in open PRs add
 * their entries in the same change that merges the route.
 */

const bearerAuth = [{ bearerAuth: [] }];

const idParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" }
});

const ok = (description: string, schemaRef?: string): Record<string, unknown> => ({
  "200": {
    description,
    ...(schemaRef
      ? { content: { "application/json": { schema: { $ref: schemaRef } } } }
      : { content: { "application/json": { schema: { type: "object" } } } })
  }
});

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "HyFib WhatsApp Platform API",
    version: "1.0.0",
    description:
      "REST API for the HyFib WhatsApp Business platform. Authenticate with a session token " +
      "(POST /auth/login) or a long-lived API key (Settings → API keys), both sent as " +
      "`Authorization: Bearer <token>`. All endpoints are tenant-scoped to your workspace. " +
      "Mutating requests are rate-limited per caller; responses use conventional status codes " +
      "with `{error, detail?}` bodies on failure."
  },
  servers: [{ url: "/", description: "This deployment" }],
  security: bearerAuth,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Session token from POST /auth/login, or an API key (hyfib_…)."
      }
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" }, detail: { type: "string" } }
      },
      Contact: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          phoneE164: { type: "string", example: "+15551234567" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          optedOut: { type: "boolean" },
          country: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          timezone: { type: "string" },
          customFields: { type: "object", additionalProperties: { type: "string" } }
        }
      },
      Template: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          category: { type: "string", enum: ["marketing", "utility", "authentication", "service"] },
          status: { type: "string", enum: ["approved", "rejected", "pending", "paused"] },
          language: { type: "string" },
          body: { type: "string" }
        }
      },
      Campaign: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          templateId: { type: "string", format: "uuid" },
          segmentId: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: ["draft", "scheduled", "running", "paused", "completed", "cancelled"]
          },
          scheduledAt: { type: "string", format: "date-time" },
          ratePerMinute: { type: "integer" }
        }
      },
      Segment: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          definition: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              country: { type: "string" },
              hasConsent: { type: "boolean" }
            }
          }
        }
      },
      Conversation: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          contactId: { type: "string", format: "uuid" },
          channelId: { type: "string", format: "uuid" },
          state: { type: "string", enum: ["open", "pending", "closed"] },
          unreadCount: { type: "integer" },
          assignedUserId: { type: "string", format: "uuid" },
          lastInboundAt: { type: "string", format: "date-time" }
        }
      },
      Message: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          conversationId: { type: "string", format: "uuid" },
          direction: { type: "string", enum: ["inbound", "outbound"] },
          status: { type: "string", enum: ["queued", "sent", "delivered", "read", "failed"] },
          payload: { type: "object" },
          createdAt: { type: "string", format: "date-time" }
        }
      }
    }
  },
  paths: {
    "/auth/login": {
      post: {
        summary: "Log in with email + password",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: { email: { type: "string" }, password: { type: "string" } }
              }
            }
          }
        },
        responses: {
          ...ok("Session created; token doubles as the Bearer credential"),
          "401": { description: "Invalid credentials" },
          "429": { description: "Rate limited" }
        }
      }
    },
    "/api/v1/contacts": {
      get: {
        summary: "List/search contacts",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Name or phone search" },
          { name: "tag", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer" } }
        ],
        responses: ok("Paginated contacts")
      },
      post: {
        summary: "Create a contact",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["phoneE164"],
                properties: {
                  phoneE164: { type: "string" },
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  country: { type: "string" },
                  timezone: { type: "string" },
                  tags: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Contact" } } }
          }
        }
      }
    },
    "/api/v1/contacts/{contactId}": {
      get: {
        summary: "Fetch one contact",
        parameters: [idParam("contactId", "Contact id")],
        responses: { ...ok("The contact", "#/components/schemas/Contact"), "404": { description: "Not found" } }
      }
    },
    "/api/v1/contacts/{contactId}/consent": {
      post: {
        summary: "Record marketing consent",
        parameters: [idParam("contactId", "Contact id")],
        responses: ok("Consent recorded")
      }
    },
    "/api/v1/contacts/{contactId}/opt-out": {
      post: {
        summary: "Opt a contact out of outbound messaging",
        parameters: [idParam("contactId", "Contact id")],
        responses: ok("Opt-out recorded")
      }
    },
    "/api/v1/contacts/import": {
      post: { summary: "Import contacts from CSV (multipart or raw text/csv)", responses: ok("Import summary") }
    },
    "/api/v1/contacts/export": {
      get: {
        summary: "Export contacts as CSV (50K cap, X-Export-Truncated header)",
        responses: { "200": { description: "CSV attachment" } }
      }
    },
    "/api/v1/templates": {
      get: {
        summary: "List message templates",
        parameters: [{ name: "status", in: "query", schema: { type: "string" } }],
        responses: ok("Templates")
      },
      post: {
        summary: "Create a local template draft",
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Template" } } }
          }
        }
      }
    },
    "/api/v1/channels/whatsapp/{channelId}/sync-templates": {
      post: {
        summary: "Pull template statuses from Meta",
        parameters: [idParam("channelId", "WhatsApp channel id")],
        responses: ok("Sync result")
      }
    },
    "/api/v1/segments": {
      get: { summary: "List segments", responses: ok("Segments") },
      post: {
        summary: "Create a segment",
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Segment" } } }
          }
        }
      }
    },
    "/api/v1/segments/{segmentId}/preview": {
      get: {
        summary: "Audience count + 5-contact sample for a segment",
        parameters: [idParam("segmentId", "Segment id")],
        responses: ok("Count and sample")
      }
    },
    "/api/v1/campaigns": {
      get: { summary: "List campaigns", responses: ok("Campaigns") },
      post: {
        summary: "Create a campaign (approved marketing template required)",
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Campaign" } } }
          }
        }
      }
    },
    "/api/v1/campaigns/{campaignId}/run": {
      post: {
        summary: "Start the full fan-out to the campaign's segment",
        parameters: [idParam("campaignId", "Campaign id")],
        responses: {
          "202": { description: "Fan-out accepted with recipientCount" },
          "409": { description: "Illegal status transition" }
        }
      }
    },
    "/api/v1/campaigns/{campaignId}/pause": {
      post: {
        summary: "Pause a running or scheduled campaign",
        parameters: [idParam("campaignId", "Campaign id")],
        responses: { ...ok("Paused"), "409": { description: "Illegal status transition" } }
      }
    },
    "/api/v1/campaigns/{campaignId}/resume": {
      post: {
        summary: "Resume a paused campaign without re-resolving the audience",
        parameters: [idParam("campaignId", "Campaign id")],
        responses: { ...ok("Resumed"), "409": { description: "Illegal status transition" } }
      }
    },
    "/api/v1/campaigns/{campaignId}/cancel": {
      post: {
        summary: "Cancel a campaign (terminal; pending sends retired)",
        parameters: [idParam("campaignId", "Campaign id")],
        responses: { ...ok("Cancelled"), "409": { description: "Illegal status transition" } }
      }
    },
    "/api/v1/campaigns/{campaignId}/report": {
      get: {
        summary: "Delivery funnel + recipient sample",
        parameters: [idParam("campaignId", "Campaign id")],
        responses: ok("Funnel and recipients")
      }
    },
    "/api/v1/conversations": {
      get: {
        summary: "List inbox conversations",
        parameters: [
          { name: "state", in: "query", schema: { type: "string", enum: ["open", "pending", "closed"] } },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "archived", in: "query", schema: { type: "boolean" } }
        ],
        responses: ok("Conversations with unread counts")
      }
    },
    "/api/v1/conversations/{conversationId}/messages": {
      get: {
        summary: "Message history for a conversation",
        parameters: [idParam("conversationId", "Conversation id")],
        responses: ok("Messages")
      },
      post: {
        summary: "Send a session message (text/media/interactive/template/location/contacts)",
        parameters: [idParam("conversationId", "Conversation id")],
        responses: {
          "202": { description: "Enqueued on the durable outbox" },
          "422": { description: "Contact opted out or payload invalid" }
        }
      }
    },
    "/api/v1/conversations/{conversationId}/assign": {
      post: {
        summary: "Assign the conversation to an agent",
        parameters: [idParam("conversationId", "Conversation id")],
        responses: ok("Assigned")
      }
    },
    "/api/v1/conversations/{conversationId}/state": {
      post: {
        summary: "Open / pend / close the conversation",
        parameters: [idParam("conversationId", "Conversation id")],
        responses: ok("Updated")
      }
    },
    "/api/v1/messages/search": {
      get: {
        summary: "Full-text search across message bodies",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        responses: ok("Matches with conversation context")
      }
    },
    "/api/v1/analytics": {
      get: {
        summary: "Workspace KPIs (optionally scoped to one campaign)",
        parameters: [{ name: "campaignId", in: "query", schema: { type: "string", format: "uuid" } }],
        responses: ok("KPIs")
      }
    },
    "/api/v1/reports/overview": {
      get: { summary: "Cross-entity totals + 14-day message trend", responses: ok("Overview") }
    },
    "/api/v1/usage": {
      get: {
        summary: "Per-day message usage by direction and category",
        parameters: [{ name: "days", in: "query", schema: { type: "integer", minimum: 1, maximum: 90 } }],
        responses: ok("Usage rows")
      }
    }
  }
} as const;
