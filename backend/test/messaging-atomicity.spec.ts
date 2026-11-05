import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  InboxPayloadConflictError,
  InboxProcessor,
} from '../src/application/messaging/inbox-processor.js';
import { BettingService } from '../src/application/services/betting.service.js';
import { WalletsService } from '../src/application/services/wallets.service.js';
import { WageringController } from '../src/api/wagering.controller.js';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.js';
import { createSqsClient } from '../src/infrastructure/sqs/sqs-config.js';
import {
  fixture,
  isolatedDatabase,
  requestBody,
  snapshot,
  withInsertFailure,
} from './support/messaging.js';

describe('Inbox + finance + ledger + Outbox: PostgreSQL real', () => {
  let orm: MikroORM;
  beforeAll(async () => {
    ({ orm } = await isolatedDatabase());
  });
  afterAll(async () => {
    if (orm) await orm.close();
  });

  it('confirma BET e Inbox com os dois eventos e preserva o envelope tipado', async () => {
    const f = await fixture(orm);
    const result = await new InboxProcessor(orm.em.fork()).process(f.body);
    expect(result.result.status).toBe('PROCESSED');
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
      balance: '75.00',
      calculated: '75.00',
      version: '2',
      transactions: 2,
      ledger: 2,
      outbox: 4,
      inbox: 1,
    });
    const events = await orm.em
      .fork()
      .execute<Array<{ payload: Record<string, unknown> }>>(
        "SELECT payload FROM outbox_messages WHERE payload #>> '{data,transactionId}' = ?",
        [result.result.transactionId],
      );
    expect(
      events
        .map((e) => String(e.payload.eventType))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const { payload } of events) {
      expect(payload.version).toBe(1);
      expect(payload.causationId).toBe(f.messageId);
      expect(payload.correlationId).toBe(f.command.idempotencyKey);
      expect(payload.aggregateId).toBe(f.command.walletId);
    }
  });

  it('50 entregas simultâneas usam uma única Inbox, movimentação e conjunto de eventos', async () => {
    const f = await fixture(orm);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        new InboxProcessor(orm.em.fork()).process(f.body),
      ),
    );
    expect(responses.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.result.transactionId)).size).toBe(1);
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
      balance: '75.00',
      calculated: '75.00',
      version: '2',
      transactions: 2,
      ledger: 2,
      outbox: 4,
      inbox: 1,
    });
  }, 30000);

  it('messageId reutilizado com conteúdo diferente conflita sem novo efeito', async () => {
    const f = await fixture(orm);
    const inbox = new InboxProcessor(orm.em.fork());
    await inbox.process(f.body);
    const before = await snapshot(orm, f.command.walletId, f.messageId);
    await expect(
      inbox.process(
        requestBody({ ...f.command, amount: '26.00' }, f.messageId),
      ),
    ).rejects.toBeInstanceOf(InboxPayloadConflictError);
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
      before,
    );
  });

  it('HTTP e depois Inbox: replay com UUIDs em maiúsculas, nova Inbox e nenhum evento extra', async () => {
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
      const { data } = JSON.parse(f.body) as { data: Record<string, unknown> };
      const first = await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', f.command.idempotencyKey)
        .send(data)
        .expect(200);
      const execution = await new InboxProcessor(orm.em.fork()).process(
        requestBody(
          {
            ...f.command,
            playerId: f.command.playerId.toUpperCase(),
            walletId: f.command.walletId.toUpperCase(),
          },
          f.messageId,
        ),
      );
      expect(execution.idempotentReplay).toBe(true);
      expect(execution.result.transactionId).toBe(first.body.transactionId);
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

  for (const kind of ['BET', 'WIN'] as const) {
    for (const table of [
      'outbox_messages',
      'wallet_ledger_entries',
      'inbox_messages',
    ] as const) {
      it(`falha real em ${table} reverte integralmente ${kind}, inclusive a Inbox`, async () => {
        const f = await fixture(orm, kind);
        const before = await snapshot(orm, f.command.walletId, f.messageId);
        await withInsertFailure(
          orm,
          table,
          table === 'inbox_messages' ? f.messageId : f.command.walletId,
          async () => {
            await expect(
              new InboxProcessor(orm.em.fork()).process(f.body),
            ).rejects.toThrow(`INJECTED_${table}_FAILURE`);
            expect(
              await snapshot(orm, f.command.walletId, f.messageId),
            ).toEqual(before);
          },
        );
        const result = await new InboxProcessor(orm.em.fork()).process(f.body);
        expect(result.idempotentReplay).toBe(false);
        const after = await snapshot(orm, f.command.walletId, f.messageId);
        expect(after.balance).toBe(kind === 'BET' ? '75.00' : '125.00');
        expect(after.balance).toBe(after.calculated);
        expect(after.outbox).toBe(4);
      });
    }
  }

  it('LOSS, rejeição financeira e referência pendente geram somente o evento correto', async () => {
    for (const [kind, amount, status, eventType] of [
      ['LOSS', '25.00', 'PROCESSED', 'WagerTransactionProcessed'],
      ['BET', '101.00', 'REJECTED', 'WagerTransactionRejected'],
      [
        'REFUND',
        '25.00',
        'PENDING_REFERENCE',
        'WagerTransactionPendingReference',
      ],
    ] as const) {
      const f = await fixture(orm, kind, amount);
      if (kind === 'REFUND')
        f.command.referenceExternalTransactionId = randomUUID();
      const execution = await new InboxProcessor(orm.em.fork()).process(
        requestBody(f.command, f.messageId),
      );
      expect(execution.result.status).toBe(status);
      const rows = await orm.em
        .fork()
        .execute<Array<{ event_type: string }>>(
          "SELECT event_type FROM outbox_messages WHERE payload #>> '{data,transactionId}' = ?",
          [execution.result.transactionId],
        );
      expect(rows).toEqual([{ event_type: eventType }]);
      expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual({
        balance: '100.00',
        calculated: '100.00',
        version: '1',
        transactions: 2,
        ledger: 1,
        outbox: 3,
        inbox: 1,
      });
    }
  });

  it('OPENING também reverte carteira, transação e ledger se a Outbox falhar', async () => {
    const playerId = randomUUID();
    await withInsertFailure(orm, 'outbox_messages', playerId, async () => {
      await expect(
        new WalletsService(orm.em.fork()).open({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      ).rejects.toThrow('INJECTED_outbox_messages_FAILURE');
    });
    const [counts] = await orm.em
      .fork()
      .execute<
        Array<{ wallets: number; transactions: number; events: number }>
      >(
        `
      SELECT (SELECT count(*)::int FROM wallets WHERE player_id = ?) AS wallets,
        (SELECT count(*)::int FROM wager_transactions WHERE player_id = ?) AS transactions,
        (SELECT count(*)::int FROM outbox_messages WHERE payload #>> '{data,playerId}' = ?) AS events
    `,
        [playerId, playerId, playerId],
      );
    expect(counts).toEqual({ wallets: 0, transactions: 0, events: 0 });
  });

  it('replay preserva resposta e saldo originais depois de WIN, REFUND e ROLLBACK', async () => {
    const f = await fixture(orm);
    const first = await new InboxProcessor(orm.em.fork()).process(f.body);
    const service = new BettingService(orm.em.fork());
    for (const [kind, reference] of [
      ['WIN', undefined],
      ['REFUND', f.command.externalTransactionId],
      ['ROLLBACK', f.command.externalTransactionId],
    ] as const) {
      await service.submitTransaction({
        ...f.command,
        kind,
        idempotencyKey: randomUUID(),
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: reference,
      });
    }
    const before = await snapshot(orm, f.command.walletId, f.messageId);
    const replay = await new InboxProcessor(orm.em.fork()).process(f.body);
    expect(replay.result).toEqual(first.result);
    expect(replay.result.balance).toBe('75.00');
    expect(await snapshot(orm, f.command.walletId, f.messageId)).toEqual(
      before,
    );
    expect(before.balance).toBe(before.calculated);
    expect(before.outbox).toBe(10);
  });

  it('o schema protege a unicidade da Inbox e a identidade do evento persistido', async () => {
    const f = await fixture(orm);
    await new InboxProcessor(orm.em.fork()).process(f.body);
    await expect(
      orm.em.fork().execute(
        `
      INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
      SELECT consumer_name, message_id, payload_hash FROM inbox_messages WHERE message_id = ?
    `,
        [f.messageId],
      ),
    ).rejects.toThrow();
    await expect(
      orm.em.fork().execute(
        `
      INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('test', ?, 'invalid')
    `,
        [randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      orm.em.fork().execute(
        `
      INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
      SELECT ?, aggregate_id, event_type, payload, occurred_at FROM outbox_messages WHERE aggregate_id = ? LIMIT 1
    `,
        [randomUUID(), f.command.walletId],
      ),
    ).rejects.toThrow();
  });

  it('proíbe iniciar o publisher com uma transação financeira aberta', async () => {
    const client = createSqsClient();
    try {
      await orm.em.fork().transactional((tx) => {
        expect(() => new OutboxPublisher(tx, client, 'unused')).toThrow(
          'dedicated EntityManager',
        );
        return Promise.resolve();
      });
    } finally {
      client.destroy();
    }
  });

  it('claims concorrentes são exclusivos e um lease expirado é recuperável', async () => {
    const client = createSqsClient(); // No network: this test exercises only the PostgreSQL claim.
    try {
      const a = new OutboxPublisher(orm.em.fork(), client, 'unused');
      const b = new OutboxPublisher(orm.em.fork(), client, 'unused');
      const ids: string[] = [];
      async function claimAll(publisher: OutboxPublisher) {
        for (;;) {
          const event = await publisher.claim();
          if (!event) break;
          ids.push(event.id);
        }
      }
      await Promise.all([claimAll(a), claimAll(b)]);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      const [count] = await orm.em
        .fork()
        .execute<Array<{ total: number }>>(
          'SELECT count(*)::int AS total FROM outbox_messages WHERE published_at IS NULL',
        );
      expect(ids.length).toBe(count.total);
      await orm.em
        .fork()
        .execute(
          "UPDATE outbox_messages SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = ?",
          [ids[0]],
        );
      const recovered = await new OutboxPublisher(
        orm.em.fork(),
        client,
        'unused',
      ).claim();
      expect(recovered?.id).toBe(ids[0]);
      expect(recovered?.attempts).toBe(2);
    } finally {
      client.destroy();
    }
  });
});
