import 'dotenv/config';
import { initializeQueues } from '../infrastructure/sqs/init-queues.js';
import { createSqsClient } from '../infrastructure/sqs/sqs-config.js';

const client = createSqsClient();
try {
  await initializeQueues(client);
  console.log('Local FIFO command/event queues and DLQs initialized');
} finally {
  client.destroy();
}
