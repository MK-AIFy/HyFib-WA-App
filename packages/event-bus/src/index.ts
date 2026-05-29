import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import type { PlatformConfig } from "@hyfib/config";
import type { EventEnvelope, EventTopic } from "@hyfib/shared-core";

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface EventBus {
  publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>>;
  /** Subscribe a durable, named queue (consumer group) to a topic. */
  subscribe(topic: EventTopic, queue: string, handler: EventHandler): void;
  close(): Promise<void>;
}

function buildEnvelope<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): EventEnvelope<TPayload> {
  return {
    id: randomUUID(),
    topic,
    tenantId,
    payload,
    occurredAt: new Date().toISOString()
  };
}

/**
 * In-process bus used for unit tests and single-process/dev runs. Delivers each
 * published event to every handler registered for the topic.
 */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<EventTopic, EventHandler[]>();

  async publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>> {
    const event = buildEnvelope(topic, payload, tenantId);
    const handlers = this.handlers.get(topic) ?? [];
    await Promise.all(handlers.map(async (handler) => handler(event)));
    return event;
  }

  subscribe(topic: EventTopic, _queue: string, handler: EventHandler): void {
    const current = this.handlers.get(topic) ?? [];
    current.push(handler);
    this.handlers.set(topic, current);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

interface Subscription {
  topic: EventTopic;
  queue: string;
  handler: EventHandler;
}

const EXCHANGE = "hyfib.events";
const DLX = "hyfib.events.dlx";

/**
 * Durable RabbitMQ transport. Publishes persistent messages to a topic exchange
 * via a confirm channel (waits for broker ack), consumes from durable named
 * queues with manual ack, and dead-letters poison messages after one retry.
 * Reconnects automatically with exponential backoff.
 */
export class RabbitMqEventBus implements EventBus {
  private channel: ConfirmChannel | undefined;
  private connecting: Promise<ConfirmChannel> | undefined;
  private readonly subscriptions: Subscription[] = [];
  private closed = false;
  private reconnectDelayMs = 1_000;
  private readonly maxReconnectDelayMs = 30_000;

  constructor(private readonly url: string) {}

  private async connect(): Promise<ConfirmChannel> {
    const connection = await amqp.connect(this.url);
    connection.on("error", () => undefined);
    connection.on("close", () => {
      this.channel = undefined;
      this.connecting = undefined;
      this.scheduleReconnect();
    });

    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DLX, "topic", { durable: true });
    this.channel = channel;
    this.reconnectDelayMs = 1_000;

    // Re-establish any consumers registered before/after a reconnect.
    for (const sub of this.subscriptions) {
      await this.setupConsumer(channel, sub);
    }
    return channel;
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
    setTimeout(() => {
      if (this.closed) {
        return;
      }
      this.ensureChannel().catch(() => this.scheduleReconnect());
    }, delay).unref();
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel) {
      return this.channel;
    }
    if (!this.connecting) {
      this.connecting = this.connect().catch((error) => {
        this.connecting = undefined;
        throw error;
      });
    }
    return this.connecting;
  }

  private async setupConsumer(channel: ConfirmChannel, sub: Subscription): Promise<void> {
    const dlq = `${sub.queue}.dlq`;
    await channel.assertQueue(sub.queue, { durable: true, deadLetterExchange: DLX });
    await channel.bindQueue(sub.queue, EXCHANGE, sub.topic);
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, DLX, sub.topic);

    await channel.consume(sub.queue, (msg: ConsumeMessage | null) => {
      if (!msg) {
        return;
      }
      void this.dispatch(channel, sub, msg);
    });
  }

  private async dispatch(channel: ConfirmChannel, sub: Subscription, msg: ConsumeMessage): Promise<void> {
    try {
      const event = JSON.parse(msg.content.toString()) as EventEnvelope;
      await sub.handler(event);
      channel.ack(msg);
    } catch {
      // Retry once (requeue); on a second failure, dead-letter the message.
      channel.nack(msg, false, !msg.fields.redelivered);
    }
  }

  async publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>> {
    const channel = await this.ensureChannel();
    const event = buildEnvelope(topic, payload, tenantId);
    const content = Buffer.from(JSON.stringify(event));
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE,
        topic,
        content,
        { persistent: true, contentType: "application/json", messageId: event.id },
        (err) => (err ? reject(err) : resolve())
      );
    });
    return event;
  }

  subscribe(topic: EventTopic, queue: string, handler: EventHandler): void {
    const sub: Subscription = { topic, queue, handler };
    this.subscriptions.push(sub);
    if (this.channel) {
      void this.setupConsumer(this.channel, sub);
    } else {
      void this.ensureChannel().catch(() => this.scheduleReconnect());
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const channel = this.channel;
    this.channel = undefined;
    if (channel) {
      const connection = channel.connection;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
  }
}

export function createEventBus(config: Pick<PlatformConfig, "eventBus" | "rabbitmqUrl">): EventBus {
  if (config.eventBus === "memory") {
    return new InMemoryEventBus();
  }
  return new RabbitMqEventBus(config.rabbitmqUrl);
}
