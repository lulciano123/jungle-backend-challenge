import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { queueNames, type QueueNames, type QueueUrls } from './sqs-config.js';

export async function initializeQueues(
  client: SQSClient,
  names: QueueNames = queueNames(),
): Promise<QueueUrls> {
  if (new Set(Object.values(names)).size !== 4)
    throw new Error('Queue names must be distinct');
  const urls = {} as QueueUrls;
  // Create FIFO queues first, then configure redrive. Safe to repeat for existing queues.
  for (const [key, name] of Object.entries(names)) {
    const response = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
    if (!response.QueueUrl) throw new Error(`Cannot initialize ${name}`);
    urls[key as keyof QueueUrls] = response.QueueUrl;
  }
  for (const [source, target] of [
    ['commands', 'commandsDlq'],
    ['events', 'eventsDlq'],
  ] as const) {
    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: urls[target],
        AttributeNames: ['QueueArn'],
      }),
    );
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) throw new Error('DLQ ARN missing');
    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: urls[source],
        Attributes: {
          VisibilityTimeout: '60',
          ReceiveMessageWaitTimeSeconds: '20',
          MessageRetentionPeriod: '345600',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: urls[target],
        Attributes: {
          MessageRetentionPeriod: '1209600',
        },
      }),
    );
  }
  return urls;
}
