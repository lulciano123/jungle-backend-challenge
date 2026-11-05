import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export async function send(
  client: SQSClient,
  url: string,
  body: string,
  group: string = randomUUID(),
) {
  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: group,
      // A distinct transport dedup ID forces application-level redelivery tests through the broker.
      MessageDeduplicationId: randomUUID(),
    }),
    { abortSignal: AbortSignal.timeout(5000) },
  );
}

export async function receive(
  client: SQSClient,
  url: string,
): Promise<Message> {
  const deadline = Date.now() + 12000;
  do {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: AbortSignal.timeout(3000) },
    );
    if (response.Messages?.[0]) return response.Messages[0];
    await delay(30);
  } while (Date.now() < deadline);
  throw new Error('No real SQS message received within 12 seconds');
}

export async function ack(client: SQSClient, url: string, message: Message) {
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: url,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );
}

export function startChild(
  schema: string,
  mode: string,
  commands: string,
  events: string,
) {
  const child = spawn(
    process.execPath,
    ['distributed-test/support/worker-process.ts'],
    {
      env: {
        ...process.env,
        DB_NAME: 'jungle_wagering_test',
        TEST_SCHEMA: schema,
        TEST_MODE: mode,
        TEST_COMMAND_URL: commands,
        TEST_EVENT_URL: events,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  // Capture no full stderr: a failure is reported by exit status, not config/credentials.
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  async function stage(name: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const line of output.split('\n')) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.stage === name) return value;
        } catch {
          /* Ignore non-JSON framework startup messages. */
        }
      }
      if (child.exitCode !== null)
        throw new Error(`Test worker exited before ${name}: ${child.exitCode}`);
      await delay(20);
    }
    child.kill('SIGKILL');
    throw new Error(`Test worker did not reach ${name}`);
  }
  return { child, exited, stage };
}

export function startRuntime(
  schema: string,
  worker: 'consumer' | 'publisher',
  queues: {
    commands: string;
    commandsDlq: string;
    events: string;
    eventsDlq: string;
  },
) {
  const applicationName = `shutdown_${randomUUID().replaceAll('-', '')}`;
  const name = (url: string) => url.slice(url.lastIndexOf('/') + 1);
  const child = spawn(process.execPath, [`dist/workers/${worker}.js`], {
    env: {
      ...process.env,
      DB_NAME: 'jungle_wagering_test',
      PGOPTIONS: `-c search_path=${schema}`,
      PGAPPNAME: applicationName,
      SQS_COMMAND_QUEUE: name(queues.commands),
      SQS_COMMAND_DLQ: name(queues.commandsDlq),
      SQS_EVENT_QUEUE: name(queues.events),
      SQS_EVENT_DLQ: name(queues.eventsDlq),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  return { child, exited, applicationName };
}
