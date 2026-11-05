import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  InboxPayloadConflictError,
  type InboxProcessor,
} from '../../application/messaging/inbox-processor.js';
import { InvalidWagerPayloadError } from '../../application/messaging/parse-wager-command.js';
import { InvalidEnvelopeError } from '../../application/messaging/wager-request.js';
import { IdempotencyConflictError } from '../../application/services/betting.service.js';
import type { QueueUrls } from './sqs-config.js';

export function permanentFailureCode(error: unknown): string | undefined {
  if (
    error instanceof InboxPayloadConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InvalidWagerPayloadError ||
    error instanceof InvalidEnvelopeError
  )
    return error.code;
  if (error instanceof Error) {
    if (error.message === 'Carteira não encontrada') return 'WALLET_NOT_FOUND';
    if (
      [
        'Carteira não pertence ao jogador',
        'Moeda incompatível com a carteira',
      ].includes(error.message)
    )
      return 'WALLET_MISMATCH';
  }
  return undefined;
}

export function retrySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(Math.max(attempt, 1), 8));
}

function log(outcome: string, message: Message, code?: string): void {
  // Never log the body, receipt handle, SQL error text or credentials.
  console.log(
    JSON.stringify({
      worker: 'wager-consumer',
      outcome,
      sqsMessageId: message.MessageId,
      code,
    }),
  );
}

export class WagerConsumer {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueUrls,
    private readonly inbox: InboxProcessor,
  ) {
    if (new Set(Object.values(queues)).size !== 4)
      throw new Error('Command and event queues must be distinct');
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queues.commands,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: signal },
    );
    for (const message of response.Messages ?? [])
      await this.handle(message, signal);
    return response.Messages?.length ?? 0;
  }

  async handle(
    message: Message,
    shutdown?: AbortSignal,
  ): Promise<'acked' | 'retry' | 'dlq'> {
    if (!message.ReceiptHandle) throw new Error('SQS receipt handle missing');
    const receipt = {
      QueueUrl: this.queues.commands,
      ReceiptHandle: message.ReceiptHandle,
    };
    try {
      if (message.Body === undefined)
        throw new InvalidEnvelopeError('Empty SQS body');
      // Resolves only after Inbox + finance + ledger + Outbox commit.
      const execution = await this.inbox.process(message.Body);
      await this.client.send(new DeleteMessageCommand(receipt), {
        abortSignal: AbortSignal.timeout(5000),
      });
      log(
        execution.idempotentReplay ? 'replay' : execution.result.status,
        message,
      );
      return 'acked';
    } catch (error) {
      const permanent = permanentFailureCode(error);
      if (permanent) {
        // If forwarding fails, leave the command unacked. The queue's redrive policy is the fallback.
        const body = message.Body ?? '';
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.queues.commandsDlq,
            MessageBody: body || '{}',
            MessageGroupId: 'invalid-commands',
            MessageDeduplicationId: createHash('sha256')
              .update(`${message.MessageId}:${body}`)
              .digest('hex'),
            MessageAttributes: {
              failureCode: { DataType: 'String', StringValue: permanent },
            },
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
        await this.client.send(new DeleteMessageCommand(receipt), {
          abortSignal: AbortSignal.timeout(5000),
        });
        log('dlq', message, permanent);
        return 'dlq';
      }
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          ...receipt,
          VisibilityTimeout: shutdown?.aborted
            ? 0
            : retrySeconds(
                Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
              ),
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      log('retry', message, 'TRANSIENT_FAILURE');
      return 'retry';
    }
  }
}
