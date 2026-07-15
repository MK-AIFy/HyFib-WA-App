import type { Logger } from "@hyfib/shared-core";
import type { OutboxRow } from "@hyfib/persistence";

export interface OutboxRelayCounters {
  published(topic: string): void;
  failed(topic: string): void;
  dead(topic: string): void;
}

export interface OutboxRelayDeps {
  claim: (limit: number) => Promise<OutboxRow[]>;
  publish: (topic: string, payload: Record<string, unknown>, tenantId?: string) => Promise<unknown>;
  markProcessed: (id: string) => Promise<void>;
  markFailed: (id: string, error: string) => Promise<void>;
  counters?: OutboxRelayCounters;
  logger: Pick<Logger, "warn" | "error">;
  /** Must match outbox_mark_failed's default attempt cap (see 015_outbox_durability.sql). */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Claims a batch of pending outbox rows and publishes them one at a time.
 * A single poison row (publish throws) is marked failed/dead via the SQL
 * attempt cap and does NOT abort the batch — every other row in the batch
 * still gets a chance to publish. Never throws: claim failures and
 * markFailed failures are logged and swallowed so the caller's polling
 * loop keeps running.
 */
export async function runOutboxRelayOnce(deps: OutboxRelayDeps, batchSize = 50): Promise<void> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let batch: OutboxRow[];
  try {
    batch = await deps.claim(batchSize);
  } catch (error) {
    deps.logger.error("outbox_relay_error", { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  for (const row of batch) {
    try {
      await deps.publish(row.topic, row.payload, row.tenant_id ?? undefined);
      await deps.markProcessed(row.id);
      deps.counters?.published(row.topic);
    } catch (publishError) {
      const message = publishError instanceof Error ? publishError.message : String(publishError);
      try {
        await deps.markFailed(row.id, message);
      } catch (markFailedError) {
        deps.logger.error("outbox_mark_failed_error", {
          id: row.id,
          topic: row.topic,
          error: markFailedError instanceof Error ? markFailedError.message : String(markFailedError)
        });
      }
      deps.counters?.failed(row.topic);
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        deps.counters?.dead(row.topic);
        deps.logger.error("outbox_row_dead", { id: row.id, topic: row.topic, attempts });
      } else {
        deps.logger.warn("outbox_publish_failed", { id: row.id, topic: row.topic, attempts, error: message });
      }
    }
  }
}
