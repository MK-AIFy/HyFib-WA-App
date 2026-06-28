import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import { loadConfig } from "@hyfib/config";
import { Logger } from "@hyfib/shared-core";

const config = loadConfig();
const logger = new Logger("queue", config.logLevel as "debug" | "info" | "warn" | "error");

export const EXCHANGE = "hyfib.events";

export interface PublishOptions {
  tenantId?: string;
  messageId?: string;
}

export interface ConsumeOptions {
  service: string;
  topics: string[];
  prefetch?: number;
}

export interface ReceivedMessage<T = unknown> {
  topic: string;
  payload: T;
  tenantId: string | undefined;
  messageId: string;
  occurredAt: string;
  raw: amqp.ConsumeMessage;
}

interface MessageEnvelope {
  id?: string;
  topic?: string;
  tenantId?: string;
  occurredAt?: string;
  payload: unknown;
}

let connection: amqp.Connection | undefined;
let publishChannel: amqp.Channel | undefined;
let connecting: Promise<void> | undefined;

async function connect(): Promise<void> {
  if (connection && publishChannel) {
    return;
  }
  if (connecting) {
    return connecting;
  }
  connecting = (async () => {
    let attempt = 0;
    let lastError: unknown;
    while (attempt < 30) {
      try {
        const conn = await amqp.connect(config.rabbitmqUrl);
        conn.on("error", (error) => {
          logger.warn("rabbitmq_connection_error", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
        conn.on("close", () => {
          logger.warn("rabbitmq_connection_closed", {});
          connection = undefined;
          publishChannel = undefined;
        });
        const channel = await conn.createChannel();
        await channel.assertExchange(EXCHANGE, "topic", { durable: true });
        connection = conn;
        publishChannel = channel;
        logger.info("rabbitmq_connected", { exchange: EXCHANGE, attempt });
        return;
      } catch (error) {
        lastError = error;
        attempt += 1;
        const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
        logger.warn("rabbitmq_connect_retry", {
          attempt,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error)
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Unable to connect to RabbitMQ");
  })();
  try {
    await connecting;
  } finally {
    connecting = undefined;
  }
}

export async function publish(topic: string, payload: unknown, options: PublishOptions = {}): Promise<void> {
  await connect();
  if (!publishChannel) {
    throw new Error("publish channel unavailable");
  }
  const messageId = options.messageId ?? randomUUID();
  const envelope: MessageEnvelope = {
    id: messageId,
    topic,
    tenantId: options.tenantId,
    occurredAt: new Date().toISOString(),
    payload
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const headers: Record<string, string> = {};
  if (options.tenantId) {
    headers["x-tenant-id"] = options.tenantId;
  }
  publishChannel.publish(EXCHANGE, topic, body, {
    contentType: "application/json",
    persistent: true,
    messageId,
    timestamp: Date.now(),
    headers
  });
}

export async function consume<T = unknown>(
  options: ConsumeOptions,
  handler: (received: ReceivedMessage<T>) => Promise<void>
): Promise<void> {
  await connect();
  if (!connection) {
    throw new Error("connection unavailable");
  }
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  const queueName = `hyfib.${options.service}`;
  await channel.assertQueue(queueName, { durable: true });
  for (const topic of options.topics) {
    await channel.bindQueue(queueName, EXCHANGE, topic);
  }
  channel.prefetch(options.prefetch ?? 16);
  await channel.consume(queueName, async (raw) => {
    if (!raw) return;
    let envelope: MessageEnvelope;
    try {
      envelope = JSON.parse(raw.content.toString("utf8")) as MessageEnvelope;
    } catch (error) {
      logger.warn("consumer_parse_failed", {
        service: options.service,
        error: error instanceof Error ? error.message : String(error)
      });
      channel.ack(raw);
      return;
    }
    try {
      await handler({
        topic: envelope.topic ?? raw.fields.routingKey,
        payload: envelope.payload as T,
        tenantId: envelope.tenantId,
        messageId: envelope.id ?? raw.properties.messageId ?? randomUUID(),
        occurredAt: envelope.occurredAt ?? new Date().toISOString(),
        raw
      });
      channel.ack(raw);
    } catch (error) {
      logger.error("consumer_handler_failed", {
        service: options.service,
        topic: envelope.topic,
        error: error instanceof Error ? error.message : String(error)
      });
      channel.nack(raw, false, false);
    }
  });
  logger.info("consumer_started", { service: options.service, queue: queueName, topics: options.topics });
}

export async function close(): Promise<void> {
  try {
    if (publishChannel) {
      await publishChannel.close();
    }
    if (connection) {
      await connection.close();
    }
  } catch {
    // ignore
  } finally {
    publishChannel = undefined;
    connection = undefined;
  }
}
