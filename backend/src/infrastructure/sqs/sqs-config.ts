import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export function integerEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

export interface QueueNames {
  commands: string;
  commandsDlq: string;
  events: string;
  eventsDlq: string;
}

export interface QueueUrls extends QueueNames {}

export function queueNames(): QueueNames {
  const names = {
    commands: process.env.SQS_COMMAND_QUEUE ?? 'wager-transactions.fifo',
    commandsDlq: process.env.SQS_COMMAND_DLQ ?? 'wager-transactions-dlq.fifo',
    events: process.env.SQS_EVENT_QUEUE ?? 'wager-events.fifo',
    eventsDlq: process.env.SQS_EVENT_DLQ ?? 'wager-events-dlq.fifo',
  };
  if (
    new Set(Object.values(names)).size !== 4 ||
    Object.values(names).some((name) => !/^[\w-]{1,75}\.fifo$/.test(name))
  ) {
    throw new Error('SQS requires four distinct FIFO queue names');
  }
  return names;
}

export function createSqsClient(): SQSClient {
  const endpoint = new URL(process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566');
  // This project targets a local emulator only. Never fall back to AWS credentials/endpoints.
  const host = endpoint.hostname;
  const localHost =
    /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|localstack|ministack|host\.docker\.internal)$/.test(
      host,
    ) || host.endsWith('.localhost.localstack.cloud');
  if (
    !localHost ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      'SQS_ENDPOINT must point to a local LocalStack/MiniStack instance',
    );
  }
  return new SQSClient({
    endpoint: endpoint.toString(),
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    useQueueUrlAsEndpoint: false,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 25000 },
  });
}

export async function resolveQueues(
  client: SQSClient,
  names: QueueNames = queueNames(),
): Promise<QueueUrls> {
  const entries = await Promise.all(
    Object.entries(names).map(async ([key, name]) => {
      const response = await client.send(
        new GetQueueUrlCommand({ QueueName: name }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      if (!response.QueueUrl) throw new Error(`Queue ${name} has no URL`);
      return [key, response.QueueUrl] as const;
    }),
  );
  const urls = Object.fromEntries(entries) as unknown as QueueUrls;
  if (new Set(Object.values(urls)).size !== 4)
    throw new Error('Command, event and DLQ URLs must be distinct');
  return urls;
}
