import type { EntityManager } from '@mikro-orm/postgresql';
import {
  BettingService,
  type PlaceBetExecution,
  type PlaceBetResult,
} from '../services/betting.service.js';
import { parseWagerRequest } from './wager-request.js';

export const WAGER_CONSUMER_NAME = 'wager-transactions-v1';

export class InboxPayloadConflictError extends Error {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';
  constructor() {
    super('messageId already received with a different payload');
  }
}

export interface InboxExecution extends PlaceBetExecution {
  inboxReplay: boolean;
}

export class InboxProcessor {
  constructor(
    private readonly em: EntityManager,
    private readonly betting = new BettingService(em),
  ) {}

  async process(body: string): Promise<InboxExecution> {
    const request = parseWagerRequest(body);
    return this.em.transactional(async (tx) => {
      // Keep SQL and shutdown bounded; another consumer can redeliver after timeout.
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '15s'");
      await tx.execute("SET LOCAL transaction_timeout = '20s'");
      await tx.execute(
        `
        INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
        VALUES (?, ?, ?) ON CONFLICT (consumer_name, message_id) DO NOTHING
      `,
        [WAGER_CONSUMER_NAME, request.messageId, request.payloadHash],
      );
      const [inbox] = await tx.execute<
        Array<{
          payload_hash: string;
          processed_at: Date | null;
          transaction_id: string | null;
        }>
      >(
        `
        SELECT payload_hash, processed_at, transaction_id FROM inbox_messages
        WHERE consumer_name = ? AND message_id = ? FOR UPDATE
      `,
        [WAGER_CONSUMER_NAME, request.messageId],
      );
      if (inbox.payload_hash !== request.payloadHash)
        throw new InboxPayloadConflictError();
      if (inbox.processed_at !== null) {
        const [original] = await tx.execute<
          Array<{ original_response: PlaceBetResult }>
        >('SELECT original_response FROM wager_transactions WHERE id = ?', [
          inbox.transaction_id,
        ]);
        return {
          result: original.original_response,
          idempotentReplay: true,
          inboxReplay: true,
        };
      }

      const execution = await this.betting.submitTransactionInTransaction(
        tx,
        request.command,
        {
          correlationId: request.correlationId,
          causationId: request.messageId,
        },
      );
      await tx.execute(
        `
        UPDATE inbox_messages SET processed_at = clock_timestamp(), transaction_id = ?
        WHERE consumer_name = ? AND message_id = ?
      `,
        [
          execution.result.transactionId,
          WAGER_CONSUMER_NAME,
          request.messageId,
        ],
      );
      return { ...execution, inboxReplay: false };
    });
  }
}
