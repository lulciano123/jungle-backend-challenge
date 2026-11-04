
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

describe('WageringController (e2e)', () => {
  let app: INestApplication<App>;
  let em: EntityManager;

  beforeAll(async () => {
    // Proteção contra gravação acidental no banco principal.
    if (process.env.DB_NAME !== 'jungle_wagering_test') {
      throw new Error(
        'Execute estes testes somente com DB_NAME=jungle_wagering_test',
      );
    }

    const moduleFixture: TestingModule =
      await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    em = app.get(EntityManager);

    const rows = await em.execute<Array<{ database_name: string }>>(
      'SELECT current_database() AS database_name',
    );

    expect(rows[0].database_name).toBe('jungle_wagering_test');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function createWallet(
    initialAmount = '100.00',
    playerId: string = randomUUID(),
  ) {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: {
          amount: initialAmount,
          currency: 'BRL',
        },
      })
      .expect(201);

    return {
      playerId: response.body.playerId as string,
      walletId: response.body.id as string,
    };
  }

  function makeBet(playerId: string, walletId: string) {
    return {
      providerId: 'wagering-e2e-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-001',
      gameId: 'game-001',
      kind: 'BET',
      money: {
        amount: '25.00',
        currency: 'BRL',
      },
    };
  }

  it('deve processar BET, persistir ledger e permitir replay', async () => {
    const { playerId, walletId } = await createWallet();
    const payload = makeBet(playerId, walletId);
    const idempotencyKey = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: {
        amount: '75.00',
        currency: 'BRL',
      },
      failureCode: null,
      idempotentReplay: false,
    });

    const second = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);

    expect(second.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: {
        amount: '75.00',
        currency: 'BRL',
      },
      idempotentReplay: true,
    });

    const wallets = await em.execute<
      Array<{ balance: string; version: string }>
    >(
      `
      SELECT
        balance::text AS balance,
        version::text AS version
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets[0]).toEqual({
      balance: '75.00',
      version: '2',
    });

    const entries = await em.execute<
      Array<{
        direction: string;
        amount: string;
        balance_before: string;
        balance_after: string;
      }>
    >(
      `
      SELECT
        direction,
        amount::text AS amount,
        balance_before::text AS balance_before,
        balance_after::text AS balance_after
      FROM wallet_ledger_entries
      WHERE transaction_id = ?
      `,
      [first.body.transactionId],
    );

    expect(entries).toEqual([
      {
        direction: 'DEBIT',
        amount: '25.00',
        balance_before: '100.00',
        balance_after: '75.00',
      },
    ]);

    const stored = await em.execute<
      Array<{ round_id: string; game_id: string }>
    >(
      `
      SELECT round_id, game_id
      FROM wager_transactions
      WHERE id = ?
      `,
      [first.body.transactionId],
    );

    expect(stored).toEqual([
      {
        round_id: 'round-001',
        game_id: 'game-001',
      },
    ]);
  });

  it('deve aceitar UUIDs em maiúsculas e reconhecer replay em minúsculas', async () => {
    const uppercasePlayerId = randomUUID().toUpperCase();
    const { playerId, walletId } = await createWallet('100.00', uppercasePlayerId);

    expect(playerId).toBe(uppercasePlayerId.toLowerCase());

    const payload = {
      ...makeBet(uppercasePlayerId, walletId.toUpperCase()),
      providerId: 'Provider-UUID-Case',
      externalTransactionId: `Transaction-${randomUUID()}`,
      roundId: 'Round-UUID-Case',
      gameId: 'Game-UUID-Case',
    };
    const idempotencyKey = `Key-UUID-Case:${randomUUID()}`;

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);

    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send({ ...payload, playerId, walletId })
      .expect(200);

    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const wallets = await em.execute<Array<{ balance: string; version: string }>>(
      `
      SELECT balance::text AS balance, version::text AS version
      FROM wallets WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets).toEqual([{ balance: '75.00', version: '2' }]);

    const transactions = await em.execute<Array<{
      id: string;
      player_id: string;
      wallet_id: string;
      provider_id: string;
      external_transaction_id: string;
      round_id: string;
      game_id: string;
      idempotency_key: string;
    }>>(
      `
      SELECT id, player_id, wallet_id, provider_id, external_transaction_id,
        round_id, game_id, idempotency_key
      FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'
      `,
      [walletId],
    );

    expect(transactions).toEqual([{
      id: first.body.transactionId,
      player_id: playerId,
      wallet_id: walletId,
      provider_id: payload.providerId,
      external_transaction_id: payload.externalTransactionId,
      round_id: payload.roundId,
      game_id: payload.gameId,
      idempotency_key: idempotencyKey,
    }]);

    const ledger = await em.execute<Array<{
      transaction_id: string;
      direction: string;
      amount: string;
    }>>(
      `
      SELECT transaction_id, direction, amount::text AS amount
      FROM wallet_ledger_entries WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(ledger).toHaveLength(2);
    expect(ledger.filter((entry) => entry.direction === 'DEBIT')).toEqual([{
      transaction_id: first.body.transactionId,
      direction: 'DEBIT',
      amount: '25.00',
    }]);
    expect(ledger.filter((entry) => entry.direction === 'CREDIT')).toHaveLength(1);
  });

  it('deve rejeitar K1 + T2 depois de processar K1 + T1 e K2 + T2', async () => {
    const { playerId, walletId } = await createWallet();
    const payload1 = makeBet(playerId, walletId);
    const payload2 = makeBet(playerId, walletId);
    const key1 = randomUUID();
    const key2 = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key1)
      .send(payload1)
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key2)
      .send(payload2)
      .expect(200);

    expect(first.body.balance.amount).toBe('75.00');
    expect(second.body.balance.amount).toBe('50.00');
    expect(second.body.transactionId).not.toBe(first.body.transactionId);

    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key1)
      .send(payload2)
      .expect(409);

    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    // As duas associações originais e seus saldos observados continuam válidos.
    for (const [key, payload, original] of [
      [key1, payload1, first.body],
      [key2, payload2, second.body],
    ] as const) {
      const replay = await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(200);

      expect(replay.body).toEqual({ ...original, idempotentReplay: true });
    }

    const wallets = await em.execute<Array<{ balance: string; version: string }>>(
      `
      SELECT balance::text AS balance, version::text AS version
      FROM wallets WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets).toEqual([{ balance: '50.00', version: '3' }]);

    const transactions = await em.execute<Array<{
      id: string;
      idempotency_key: string;
      external_transaction_id: string;
    }>>(
      `
      SELECT id, idempotency_key, external_transaction_id
      FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'
      `,
      [walletId],
    );

    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(expect.arrayContaining([
      { id: first.body.transactionId, idempotency_key: key1,
        external_transaction_id: payload1.externalTransactionId },
      { id: second.body.transactionId, idempotency_key: key2,
        external_transaction_id: payload2.externalTransactionId },
    ]));

    const ledger = await em.execute<Array<{ direction: string; total: number }>>(
      `
      SELECT direction, COUNT(*)::int AS total
      FROM wallet_ledger_entries WHERE wallet_id = ?
      GROUP BY direction ORDER BY direction
      `,
      [walletId],
    );

    expect(ledger).toEqual([
      { direction: 'CREDIT', total: 1 },
      { direction: 'DEBIT', total: 2 },
    ]);
  });

  it('deve rejeitar aposta sem saldo com HTTP 422', async () => {
    const { playerId, walletId } = await createWallet('10.00');
    const payload = makeBet(playerId, walletId);

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(422);

    expect(response.body).toMatchObject({
      status: 'REJECTED',
      code: 'INSUFFICIENT_FUNDS',
      balance: {
        amount: '10.00',
        currency: 'BRL',
      },
      idempotentReplay: false,
    });
  });

  it('deve exigir Idempotency-Key', async () => {
    const { playerId, walletId } = await createWallet();
    const payload = makeBet(playerId, walletId);

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(payload)
      .expect(400);

    expect(response.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('deve rejeitar kind não implementado', async () => {
    const { playerId, walletId } = await createWallet();
    const payload = {
      ...makeBet(playerId, walletId),
      kind: 'WIN',
    };

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(400);

    expect(response.body.code).toBe('UNSUPPORTED_TRANSACTION_KIND');
  });

  it('deve rejeitar mesma chave com payload diferente', async () => {
    const { playerId, walletId } = await createWallet();
    const payload = makeBet(playerId, walletId);
    const idempotencyKey = randomUUID();

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        ...payload,
        money: {
          amount: '30.00',
          currency: 'BRL',
        },
      })
      .expect(409);

    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
