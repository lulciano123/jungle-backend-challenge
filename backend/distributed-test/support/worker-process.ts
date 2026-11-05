import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import ormConfig from '../../src/mikro-orm.config.js';
import { InboxProcessor } from '../../src/application/messaging/inbox-processor.js';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox-publisher.js';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-config.js';
import { WagerConsumer } from '../../src/infrastructure/sqs/wager-consumer.js';

const schema = process.env.TEST_SCHEMA ?? '';
if (
  process.env.DB_NAME !== 'jungle_wagering_test' ||
  !/^messaging_[0-9a-f]{32}$/.test(schema)
) {
  throw new Error('Unsafe distributed test child configuration');
}
const orm = await MikroORM.init({
  ...ormConfig,
  dbName: 'jungle_wagering_test',
  schema,
  driverOptions: { options: `-c search_path=${schema}` },
});
const client = createSqsClient();
try {
  const mode = process.env.TEST_MODE;
  if (mode === 'consumer-crash' || mode === 'consumer-once') {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: process.env.TEST_COMMAND_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: mode === 'consumer-crash' ? 2 : 60,
      }),
    );
    const message = response.Messages?.[0];
    if (!message?.Body) throw new Error('No test command received');
    if (mode === 'consumer-crash') {
      const execution = await new InboxProcessor(orm.em.fork()).process(
        message.Body,
      );
      console.log(
        JSON.stringify({
          stage: 'committed',
          transactionId: execution.result.transactionId,
        }),
      );
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    } else {
      const commands = process.env.TEST_COMMAND_URL!;
      const events = process.env.TEST_EVENT_URL!;
      await new WagerConsumer(
        client,
        {
          commands,
          events,
          commandsDlq: commands.replace(/commands\.fifo$/, 'commands-dlq.fifo'),
          eventsDlq: events.replace(/events\.fifo$/, 'events-dlq.fifo'),
        },
        new InboxProcessor(orm.em.fork()),
      ).handle(message);
    }
  } else {
    const publisher = new OutboxPublisher(
      orm.em.fork(),
      client,
      process.env.TEST_EVENT_URL!,
    );
    if (mode === 'publisher-drain') {
      let count = 0;
      while (await publisher.publishOnce()) {
        if (++count > 2000) throw new Error('Unbounded test publisher loop');
      }
    } else if (
      mode === 'publisher-crash-claimed' ||
      mode === 'publisher-crash-sent'
    ) {
      const event = await publisher.claim();
      if (!event) throw new Error('No pending test event');
      if (mode === 'publisher-crash-sent') {
        await client.send(
          new SendMessageCommand({
            QueueUrl: process.env.TEST_EVENT_URL,
            MessageBody: JSON.stringify(event.payload),
            MessageGroupId: event.aggregate_id,
            MessageDeduplicationId: event.id,
          }),
        );
      }
      console.log(JSON.stringify({ stage: 'claimed', eventId: event.id }));
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    } else throw new Error('Unknown test child mode');
  }
} finally {
  await orm.close();
  client.destroy();
}
