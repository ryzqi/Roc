import type { EventSubscription, RocEventBus, RocEventEnvelope } from './types';

type EventHandler<TPayload = unknown> = (event: RocEventEnvelope<TPayload>) => void | Promise<void>;

type EventBusLogger = {
  error(message: string, metadata?: Record<string, unknown>): void;
};

type SubscriptionRecord = {
  type: string;
  handler: EventHandler;
};

export class EventBus implements RocEventBus {
  private readonly subscriptions: SubscriptionRecord[] = [];

  constructor(private readonly logger: EventBusLogger) {}

  async publish<TPayload>(event: RocEventEnvelope<TPayload>): Promise<void> {
    const failures: Error[] = [];
    const matchingSubscriptions = this.subscriptions.filter((subscription) => subscription.type === event.type);

    for (const subscription of matchingSubscriptions) {
      try {
        await subscription.handler(event);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        this.logger.error('event_handler_failed', {
          eventType: event.type,
          source: event.source,
          errorMessage: failure.message
        });
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, 'event_publish_failed');
    }
  }

  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): EventSubscription {
    const record: SubscriptionRecord = {
      type,
      handler: handler as EventHandler
    };
    this.subscriptions.push(record);
    return () => {
      const index = this.subscriptions.indexOf(record);
      if (index !== -1) {
        this.subscriptions.splice(index, 1);
      }
    };
  }
}
