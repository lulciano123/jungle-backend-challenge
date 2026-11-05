import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../../domain/events/integration-event.js';

// Only uses the caller's transaction. No publishing or independent commit here.
export async function writeEvents(
  tx: EntityManager,
  events: IntegrationEvent<unknown>[],
): Promise<void> {
  if (!tx.isInTransaction())
    throw new Error('Outbox requires an active SQL transaction');
  for (const event of events) {
    await tx.execute(
      `
      INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
      VALUES (?, ?, ?, ?::jsonb, ?)
    `,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.toJSON()),
        event.occurredAt,
      ],
    );
  }
}
