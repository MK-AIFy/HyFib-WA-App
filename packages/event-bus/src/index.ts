import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventTopic } from "@hyfib/shared-core";

type Handler = (event: EventEnvelope) => Promise<void> | void;

export interface EventBus {
  publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>>;
  subscribe(topic: EventTopic, handler: Handler): void;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<EventTopic, Handler[]>();

  async publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>> {
    const event: EventEnvelope<TPayload> = {
      id: randomUUID(),
      topic,
      tenantId,
      payload,
      occurredAt: new Date().toISOString()
    };

    const handlers = this.handlers.get(topic) ?? [];
    await Promise.all(handlers.map(async (handler) => handler(event)));
    return event;
  }

  subscribe(topic: EventTopic, handler: Handler): void {
    const current = this.handlers.get(topic) ?? [];
    current.push(handler);
    this.handlers.set(topic, current);
  }
}

export class RabbitMqEventBus implements EventBus {
  constructor(private readonly fallback: EventBus = new InMemoryEventBus()) {}

  async publish<TPayload>(topic: EventTopic, payload: TPayload, tenantId?: string): Promise<EventEnvelope<TPayload>> {
    // Placeholder adapter: until RabbitMQ transport wiring is completed,
    // keep deterministic behavior through the in-memory bus.
    return this.fallback.publish(topic, payload, tenantId);
  }

  subscribe(topic: EventTopic, handler: Handler): void {
    this.fallback.subscribe(topic, handler);
  }
}
