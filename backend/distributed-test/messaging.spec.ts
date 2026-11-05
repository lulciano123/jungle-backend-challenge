import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { InboxProcessor } from '../src/application/messaging/inbox-processor.js';
import { BettingService } from '../src/application/services/betting.service.js';
import { WageringController } from '../src/api/wagering.controller.js';
import { HealthController } from '../src/health.controller.js';
import {
  createSqsClient,
  type QueueUrls,
} from '../src/infrastructure/sqs/sqs-config.js';
import { initializeQueues } from '../src/infrastructure/sqs/init-queues.js';
import { WagerConsumer } from '../src/infrastructure/sqs/wager-consumer.js';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.js';
import {
  fixture,
  isolatedDatabase,
  requestBody,
  snapshot,
  withInsertFailure,
} from '../test/support/messaging.js';
import { ack, receive, send, startChild, startRuntime } from './support/sqs.js';

describe('PostgreSQL + SQS reais (sem mocks)', () => {
  let client: SQSClient;
  let queues: QueueUrls;
  let orm: MikroORM;
  let schema: string;
  let consumer: WagerConsumer;

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'jungle_wagering_test')
      throw new Error('Use exclusively DB_NAME=jungle_wagering_test');
    client = createSqsClient();
    const prefix = `jt-${randomUUID()}`;
    try {
      queues = await initializeQueues(client, {
        commands: `${prefix}-commands.fifo`,
        commandsDlq: `${prefix}-commands-dlq.fifo`,
        events: `${prefix}-events.fifo`,
        eventsDlq: `${prefix}-events-dlq.fifo`,
      });
    } catch {
      throw new Error(
        'SQS REAL UNAVAILABLE: start Compose MiniStack/LocalStack at SQS_ENDPOINT; this suite cannot be replaced by mocks',
      );
    }
    ({ orm, schema } = await isolatedDatabase());
    consumer = new WagerConsumer(
      client,
      queues,
      new InboxProcessor(orm.em.fork()),
    );
  }, 30000);
  afterAll(async () => {
    if (orm) await orm.close();
    client?.destroy();
  });

  it('inicializa quatro filas FIFO distintas e redrive para a DLQ correta', async () => {
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.commands,
        AttributeNames: ['All'],
      }),
    );
    const dlq = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.commandsDlq,
        AttributeNames: ['QueueArn'],
      }),
    );
    expect(Attributes?.FifoQueue).toBe('true');
    expect(Attributes?.VisibilityTimeout).toBe('60');
    expect(JSON.parse(Attributes!.RedrivePolicy!)).toEqual({
      deadLetterTargetArn: dlq.Attributes!.QueueArn,
      maxReceiveCount: '5',
    });
    expect(new Set(Object.values(queues)).size).toBe(4);
  });

  it('readiness verifica PostgreSQL e as filas SQS reais', async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: CoreMikroORM, useValue: orm }],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/health/live').expect(200);
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      expect(response.body).toEqual({
        status: 'ok',
        database: 'up',
        sqs: 'up',
      });
    } finally {
      await app.close();
    }
  });

  it('BET pela fila confirma wallet + ledger + Inbox + Outbox antes de remover a mensagem', async () => {
    const f = await fixture(orm);
    await send(client, queues.commands, f.body, f.command.walletId);
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'acked',
    );
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
      balance: '75.00',
      calculated: '75.00',
      version: '2',
      transactions: 2,
      ledger: 2,
      outbox: 4,
      inbox: 1,
    });
    const status = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.commands,
        AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    expect(status.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
  });

  it('redelivery real com o mesmo messageId não duplica débito', async () => {
    const f = await fixture(orm);
    await send(client, queues.commands, f.body, f.command.walletId);
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'acked',
    );
    const before = await snapshot(orm, f.command.walletId, f.messageId);
    await send(client, queues.commands, f.body, f.command.walletId);
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'acked',
    );
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
      before,
    );
  });

  it('mesmo messageId com payload diferente vai para DLQ sem outro efeito', async () => {
    const f = await fixture(orm);
    await send(client, queues.commands, f.body);
    await consumer.handle(await receive(client, queues.commands));
    const before = await snapshot(orm, f.command.walletId, f.messageId);
    await send(
      client,
      queues.commands,
      requestBody({ ...f.command, amount: '26.00' }, f.messageId),
    );
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'dlq',
    );
    const dead = await receive(client, queues.commandsDlq);
    expect(dead.MessageAttributes?.failureCode.StringValue).toBe(
      'INBOX_PAYLOAD_CONFLICT',
    );
    await ack(client, queues.commandsDlq, dead);
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
      before,
    );
  });

  it('HTTP seguido da fila completa Inbox sem reaplicar BET nem gerar eventos', async () => {
    const f = await fixture(orm);
    const module = await Test.createTestingModule({
      controllers: [WageringController],
      providers: [
        {
          provide: BettingService,
          useValue: new BettingService(orm.em.fork()),
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const data = (JSON.parse(f.body) as { data: object }).data;
      const response = await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', f.command.idempotencyKey)
        .send(data)
        .expect(200);
      await send(client, queues.commands, f.body);
      expect(
        await consumer.handle(await receive(client, queues.commands)),
      ).toBe('acked');
      const [inbox] = await orm.em
        .fork()
        .execute<Array<{ transaction_id: string; processed_at: Date }>>(
          'SELECT transaction_id, processed_at FROM inbox_messages WHERE message_id = ?',
          [f.messageId],
        );
      expect(inbox.transaction_id).toBe(response.body.transactionId);
      expect(inbox.processed_at).toBeTruthy();
      expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
        balance: '75.00',
        calculated: '75.00',
        version: '2',
        transactions: 2,
        ledger: 2,
        outbox: 4,
        inbox: 1,
      });
    } finally {
      await app.close();
    }
  });

  for (const table of ['outbox_messages', 'wallet_ledger_entries'] as const) {
    it(`falha real no INSERT ${table}: rollback completo, sem ack, redelivery recupera`, async () => {
      const f = await fixture(orm);
      const before = await snapshot(orm, f.command.walletId, f.messageId);
      await send(client, queues.commands, f.body);
      const message = await receive(client, queues.commands);
      await withInsertFailure(orm, table, f.command.walletId, async () => {
        expect(await consumer.handle(message)).toBe('retry');
        expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
          before,
        );
        const attr = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queues.commands,
            AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
          }),
        );
        expect(attr.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe(
          '1',
        );
      });
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.commands,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const redelivery = await receive(client, queues.commands);
      expect(redelivery.MessageId).toBe(message.MessageId);
      expect(await consumer.handle(redelivery)).toBe('acked');
      const after = await snapshot(orm, f.command.walletId, f.messageId);
      expect(after.balance).toBe('75.00');
      expect(after.balance).toBe(after.calculated);
      expect(after.ledger).toBe(2);
      expect(after.outbox).toBe(4);
    });
  }

  it('rejeição de negócio é persistida, gera evento, completa Inbox e recebe ack', async () => {
    const f = await fixture(orm, 'BET', '101.00');
    await send(client, queues.commands, f.body);
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'acked',
    );
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
      balance: '100.00',
      calculated: '100.00',
      version: '1',
      transactions: 2,
      ledger: 1,
      outbox: 3,
      inbox: 1,
    });
    const [tx] = await orm.em
      .fork()
      .execute<Array<{ status: string; failure_code: string }>>(
        'SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = ?',
        [f.command.idempotencyKey],
      );
    expect(tx).toEqual({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
  });

  it('preserva BET, WIN, LOSS, REFUND e ROLLBACK pelo mesmo caso de uso da fila', async () => {
    const f = await fixture(orm);
    const winExternalId = randomUUID();
    const commands = [
      f.command,
      {
        ...f.command,
        kind: 'WIN' as const,
        amount: '10.00',
        externalTransactionId: winExternalId,
        idempotencyKey: randomUUID(),
        playerId: f.command.playerId.toUpperCase(),
        walletId: f.command.walletId.toUpperCase(),
      },
      {
        ...f.command,
        kind: 'LOSS' as const,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
      {
        ...f.command,
        kind: 'REFUND' as const,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        referenceExternalTransactionId: f.command.externalTransactionId,
      },
      {
        ...f.command,
        kind: 'ROLLBACK' as const,
        amount: '10.00',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        referenceExternalTransactionId: winExternalId,
      },
    ];
    for (const command of commands) {
      await send(client, queues.commands, requestBody(command));
      expect(
        await consumer.handle(await receive(client, queues.commands)),
      ).toBe('acked');
    }
    const state = await snapshot(orm, f.command.walletId, 'unused');
    expect(state).toEqual({
      balance: '100.00',
      calculated: '100.00',
      version: '5',
      transactions: 6,
      ledger: 5,
      outbox: 11,
      inbox: 0,
    });
    await send(
      client,
      queues.commands,
      requestBody({
        ...commands[3],
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'acked',
    );
    const after = await snapshot(orm, f.command.walletId, 'unused');
    expect(after.balance).toBe('100.00');
    expect(after.version).toBe('5');
    expect(after.ledger).toBe(5);
    expect(after.outbox).toBe(12);
  });

  it('envelope inválido vai para DLQ sem Inbox nem transação financeira', async () => {
    await send(client, queues.commands, '{invalid');
    expect(await consumer.handle(await receive(client, queues.commands))).toBe(
      'dlq',
    );
    const dead = await receive(client, queues.commandsDlq);
    expect(dead.Body).toBe('{invalid');
    expect(dead.MessageAttributes?.failureCode.StringValue).toBe(
      'INVALID_ENVELOPE',
    );
    await ack(client, queues.commandsDlq, dead);
  });

  it('falha transitória repetida esgota o limite do broker e termina na DLQ sem débito', async () => {
    const f = await fixture(orm);
    const before = await snapshot(orm, f.command.walletId, f.messageId);
    const dlq = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.commandsDlq,
        AttributeNames: ['QueueArn'],
      }),
    );
    async function limit(maxReceiveCount: string) {
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: queues.commands,
          Attributes: {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlq.Attributes!.QueueArn,
              maxReceiveCount,
            }),
          },
        }),
      );
    }
    await limit('2');
    try {
      await send(client, queues.commands, f.body);
      await withInsertFailure(
        orm,
        'wallet_ledger_entries',
        f.command.walletId,
        async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            const message = await receive(client, queues.commands);
            expect(await consumer.handle(message)).toBe('retry');
            await client.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: queues.commands,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              }),
            );
          }
          // Receiving is what lets SQS apply its redrive policy; no application-side fake DLQ.
          await client.send(
            new ReceiveMessageCommand({
              QueueUrl: queues.commands,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
            }),
          );
          const dead = await receive(client, queues.commandsDlq);
          expect(dead.Body).toBe(f.body);
          await ack(client, queues.commandsDlq, dead);
          expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
            before,
          );
        },
      );
    } finally {
      await limit('5');
    }
  });

  it('SIGKILL depois do commit e antes do ack permite redelivery sem novo débito', async () => {
    const f = await fixture(orm);
    await send(client, queues.commands, f.body);
    const process = startChild(
      schema,
      'consumer-crash',
      queues.commands,
      queues.events,
    );
    try {
      await process.stage('committed');
      process.child.kill('SIGKILL');
      await process.exited;
      const before = await snapshot(orm, f.command.walletId, f.messageId);
      expect(before.balance).toBe('75.00');
      expect(
        await consumer.handle(await receive(client, queues.commands)),
      ).toBe('acked');
      expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
        before,
      );
    } finally {
      if (process.child.exitCode === null) process.child.kill('SIGKILL');
    }
  });

  it('três consumidores em processos independentes preservam uma única movimentação', async () => {
    const f = await fixture(orm, 'WIN');
    for (let i = 0; i < 3; i++) await send(client, queues.commands, f.body); // Different transport groups deliberately defeat FIFO serialization.
    const children = Array.from({ length: 3 }, () =>
      startChild(schema, 'consumer-once', queues.commands, queues.events),
    );
    try {
      expect(await Promise.all(children.map((c) => c.exited))).toEqual([
        0, 0, 0,
      ]);
      expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
        balance: '125.00',
        calculated: '125.00',
        version: '2',
        transactions: 2,
        ledger: 2,
        outbox: 4,
        inbox: 1,
      });
    } finally {
      for (const c of children)
        if (c.child.exitCode === null) c.child.kill('SIGKILL');
    }
  });

  for (const worker of ['consumer', 'publisher'] as const) {
    it(`SIGTERM aguarda a operação em andamento do entrypoint real ${worker}`, async () => {
      const f = await fixture(orm);
      const trigger = `pause_${randomUUID().replaceAll('-', '')}`;
      const action = worker === 'consumer' ? 'INSERT' : 'UPDATE';
      await orm.em.fork()
        .execute(`CREATE FUNCTION ${trigger}() RETURNS trigger AS $$
        BEGIN IF NEW.aggregate_id = '${f.command.walletId}'::uuid THEN PERFORM pg_sleep(0.5); END IF;
        RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await orm.em
        .fork()
        .execute(
          `CREATE TRIGGER ${trigger} BEFORE ${action} ON outbox_messages FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        );
      if (worker === 'consumer') await send(client, queues.commands, f.body);
      const process = startRuntime(schema, worker, queues);
      try {
        let sleeping = false;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const [state] = await orm.em
            .fork()
            .execute<Array<{ count: number }>>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ? AND wait_event = 'PgSleep'",
              [process.applicationName],
            );
          if (state.count > 0) {
            sleeping = true;
            break;
          }
          if (process.child.exitCode !== null)
            throw new Error(`Worker ${worker} exited before processing`);
          await delay(20);
        }
        expect(sleeping).toBe(true);
        process.child.kill('SIGTERM');
        expect(await process.exited).toBe(0);
        const state = await snapshot(orm, f.command.walletId, f.messageId);
        expect(state.balance).toBe(state.calculated);
        if (worker === 'consumer') {
          expect(state.balance).toBe('75.00');
          expect(state.inbox).toBe(1);
          expect(state.outbox).toBe(4);
          const attributes = await client.send(
            new GetQueueAttributesCommand({
              QueueUrl: queues.commands,
              AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
            }),
          );
          expect(
            attributes.Attributes?.ApproximateNumberOfMessagesNotVisible,
          ).toBe('0');
        } else {
          const [row] = await orm.em
            .fork()
            .execute<Array<{ count: number }>>(
              'SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NOT NULL',
              [f.command.walletId],
            );
          expect(row.count).toBeGreaterThan(0);
        }
      } finally {
        if (process.child.exitCode === null) {
          process.child.kill('SIGKILL');
          await process.exited;
        }
        await orm.em
          .fork()
          .execute(`DROP TRIGGER ${trigger} ON outbox_messages`);
        await orm.em.fork().execute(`DROP FUNCTION ${trigger}()`);
      }
    });
  }

  it('dois publishers reais publicam todos os eventos sem perdas ou ciclo para a entrada', async () => {
    const [before] = await orm.em
      .fork()
      .execute<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM outbox_messages',
      );
    const children = Array.from({ length: 2 }, () =>
      startChild(schema, 'publisher-drain', queues.commands, queues.events),
    );
    try {
      expect(await Promise.all(children.map((c) => c.exited))).toEqual([0, 0]);
    } finally {
      for (const c of children)
        if (c.child.exitCode === null) c.child.kill('SIGKILL');
    }
    const rows = await orm.em
      .fork()
      .execute<Array<{ id: string }>>(
        'SELECT id FROM outbox_messages WHERE published_at IS NOT NULL',
      );
    expect(rows).toHaveLength(before.count);
    const received = new Set<string>();
    for (let i = 0; i < before.count; i++) {
      const message = await receive(client, queues.events);
      const event = JSON.parse(message.Body!) as {
        eventId: string;
        eventType: string;
      };
      expect(event.eventType).not.toBe('WagerTransactionRequested');
      expect(received.has(event.eventId)).toBe(false);
      received.add(event.eventId);
      await ack(client, queues.events, message);
    }
    expect([...received].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  for (const stage of ['claimed', 'sent'] as const) {
    it(`recupera publisher morto após ${stage}, preservando eventId estável`, async () => {
      await fixture(orm, 'WIN'); // Two new OPENING events, nothing is published inline.
      const process = startChild(
        schema,
        `publisher-crash-${stage}`,
        queues.commands,
        queues.events,
      );
      let id: string;
      try {
        const notification = await process.stage('claimed');
        id = notification.eventId as string;
        process.child.kill('SIGKILL');
        await process.exited;
      } finally {
        if (process.child.exitCode === null) process.child.kill('SIGKILL');
      }
      const [pending] = await orm.em
        .fork()
        .execute<Array<{ published_at: Date | null; claim_token: string }>>(
          'SELECT published_at, claim_token FROM outbox_messages WHERE id = ?',
          [id!],
        );
      expect(pending.published_at).toBeNull();
      expect(pending.claim_token).toBeTruthy();
      // Advance only the abandoned test lease; do not alter financial data.
      await orm.em
        .fork()
        .execute(
          "UPDATE outbox_messages SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = ?",
          [id!],
        );
      const publisher = new OutboxPublisher(
        orm.em.fork(),
        client,
        queues.events,
      );
      while (await publisher.publishOnce()) {
        /* Drain durable events. */
      }
      const [published] = await orm.em
        .fork()
        .execute<Array<{ published_at: Date | null; attempts: number }>>(
          'SELECT published_at, attempts FROM outbox_messages WHERE id = ?',
          [id!],
        );
      expect(published.published_at).not.toBeNull();
      expect(published.attempts).toBe(2);
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const event = await receive(client, queues.events);
        ids.push((JSON.parse(event.Body!) as { eventId: string }).eventId);
        await ack(client, queues.events, event);
      }
      expect(ids.filter((value) => value === id!)).toHaveLength(1);
    });
  }

  it('erro de publicação real conserva evento pendente e agenda retry antes de recuperá-lo', async () => {
    await fixture(orm);
    const invalidQueue = queues.events.replace(
      /[^/]+$/,
      'nonexistent-test-queue.fifo',
    );
    const broken = new OutboxPublisher(orm.em.fork(), client, invalidQueue);
    expect(await broken.publishOnce()).toBe(true);
    const [event] = await orm.em.fork().execute<
      Array<{
        id: string;
        published_at: Date | null;
        attempts: number;
        claim_token: string | null;
        delayed: boolean;
      }>
    >("SELECT id, published_at, attempts, claim_token, next_attempt_at > clock_timestamp() AS delayed FROM outbox_messages WHERE last_error = 'PUBLISH_OR_CONFIRM_FAILED' ORDER BY occurred_at DESC LIMIT 1");
    expect(event.published_at).toBeNull();
    expect(event.attempts).toBe(1);
    expect(event.claim_token).toBeNull();
    expect(event.delayed).toBe(true);
    await orm.em
      .fork()
      .execute(
        'UPDATE outbox_messages SET next_attempt_at = clock_timestamp() WHERE id = ?',
        [event.id],
      );
    const publisher = new OutboxPublisher(orm.em.fork(), client, queues.events);
    while (await publisher.publishOnce()) {
      /* Publish after service recovery. */
    }
    const [row] = await orm.em
      .fork()
      .execute<Array<{ published_at: Date | null }>>(
        'SELECT published_at FROM outbox_messages WHERE id = ?',
        [event.id],
      );
    expect(row.published_at).not.toBeNull();
  });
});
