import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../mikro-orm.config.js';
import { OutboxPublisher } from '../infrastructure/outbox/outbox-publisher.js';
import {
  createSqsClient,
  resolveQueues,
} from '../infrastructure/sqs/sqs-config.js';
import { logWorkerError, pause, shutdownSignal } from './runtime.js';

const signal = shutdownSignal();
const client = createSqsClient();
const orm = await MikroORM.init(ormConfig);
try {
  const publisher = new OutboxPublisher(
    orm.em.fork(),
    client,
    (await resolveQueues(client)).events,
  );
  while (!signal.aborted) {
    try {
      if (!(await publisher.publishOnce())) await pause(500, signal);
    } catch {
      logWorkerError('outbox-publisher');
      await pause(2000, signal);
    }
  }
} finally {
  // Do not abort an in-flight send/confirmation. An unconfirmed claim expires safely.
  await orm.close();
  client.destroy();
}
