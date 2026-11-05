import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface ClaimedEvent {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  claim_token: string;
}

export class OutboxPublisher {
  constructor(
    private readonly em: EntityManager,
    private readonly client: SQSClient,
    private readonly eventQueueUrl: string,
    private readonly leaseSeconds = 60,
  ) {
    if (em.isInTransaction())
      throw new Error(
        'Outbox publisher requires a dedicated EntityManager without an active transaction',
      );
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15)
      throw new Error('Outbox lease must be at least 15 seconds');
  }

  async claim(): Promise<ClaimedEvent | undefined> {
    // A short, independent claim transaction ends before any SQS network call.
    const rows = await this.em.transactional((tx) =>
      tx.execute<ClaimedEvent[]>(
        `
      WITH candidate AS (
        SELECT id FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= clock_timestamp()
          AND (claimed_until IS NULL OR claimed_until <= clock_timestamp())
        ORDER BY next_attempt_at, occurred_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE outbox_messages o
      SET claim_token = ?, claimed_until = clock_timestamp() + (? * interval '1 second'),
          attempts = attempts + 1
      FROM candidate c WHERE o.id = c.id
      RETURNING o.id, o.aggregate_id, o.payload, o.attempts, o.claim_token
    `,
        [randomUUID(), this.leaseSeconds],
      ),
    );
    return rows[0];
  }

  async publishOnce(): Promise<boolean> {
    const event = await this.claim();
    if (!event) return false;
    try {
      const response = await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.eventQueueUrl,
          MessageBody: JSON.stringify(event.payload),
          MessageGroupId: event.aggregate_id,
          MessageDeduplicationId: event.id,
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (!response.MessageId)
        throw new Error('SQS did not confirm publication');
      await this.em.fork().execute(
        `
        UPDATE outbox_messages
        SET published_at = clock_timestamp(), claim_token = NULL, claimed_until = NULL, last_error = NULL
        WHERE id = ? AND claim_token = ? AND published_at IS NULL
      `,
        [event.id, event.claim_token],
      );
      console.log(
        JSON.stringify({
          worker: 'outbox-publisher',
          outcome: 'published',
          eventId: event.id,
        }),
      );
    } catch {
      const backoff = Math.min(3600, 2 ** Math.min(event.attempts, 11));
      await this.em.fork().execute(
        `
        UPDATE outbox_messages
        SET next_attempt_at = clock_timestamp() + (? * interval '1 second'),
          claim_token = NULL, claimed_until = NULL, last_error = 'PUBLISH_OR_CONFIRM_FAILED'
        WHERE id = ? AND claim_token = ? AND published_at IS NULL
      `,
        [backoff, event.id, event.claim_token],
      );
      console.log(
        JSON.stringify({
          worker: 'outbox-publisher',
          outcome: 'retry',
          eventId: event.id,
          attempt: event.attempts,
        }),
      );
    }
    return true;
  }
}
