import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../mikro-orm.config.js';
import { InboxProcessor } from '../application/messaging/inbox-processor.js';
import {
  createSqsClient,
  resolveQueues,
} from '../infrastructure/sqs/sqs-config.js';
import { WagerConsumer } from '../infrastructure/sqs/wager-consumer.js';
import { logWorkerError, pause, shutdownSignal } from './runtime.js';

const signal = shutdownSignal();
const client = createSqsClient();
const orm = await MikroORM.init(ormConfig);
try {
  const consumer = new WagerConsumer(
    client,
    await resolveQueues(client),
    new InboxProcessor(orm.em.fork()),
  );
  while (!signal.aborted) {
    try {
      await consumer.pollOnce(signal);
    } catch {
      if (!signal.aborted) {
        logWorkerError('wager-consumer');
        await pause(2000, signal);
      }
    }
  }
} finally {
  // pollOnce finishes the current SQL operation and its ack before returning.
  await orm.close();
  client.destroy();
}
