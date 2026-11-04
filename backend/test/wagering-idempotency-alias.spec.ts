
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

describe('Wagering - Integridade da Idempotency-Key', () => {
  let app: INestApplication<App>;
  let em: EntityManager;

  beforeAll(async () => {
    // Nunca executar este teste no banco principal.
    if (process.env.DB_NAME !== 'jungle_wagering_test') {
      throw new Error(
        'Use DB_NAME=jungle_wagering_test',
      );
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    em = app.get(EntityManager);

    const rows = await em.execute<
      Array<{ database_name: string }>
    >('SELECT current_database() AS database_name');

    expect(rows[0].database_name).toBe('jungle_wagering_test');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('não deve aceitar outra chave para a mesma transação externa', async () => {
    const playerId = randomUUID();

    // Abre uma carteira real com R$ 100.
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      })
      .expect(201);

    const walletId = walletResponse.body.id as string;

    // Operação financeira que queremos proteger.
    const payload = {
      providerId: 'alias-regression-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-alias-test',
      gameId: 'game-alias-test',
      kind: 'BET',
      money: {
        amount: '10.00',
        currency: 'BRL',
      },
    };

    const key1 = randomUUID();
    const key2 = randomUUID();

    // K1 + T1: primeira aposta legítima.
    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key1)
      .send(payload)
      .expect(200);

    expect(first.body.status).toBe('PROCESSED');
    expect(first.body.balance.amount).toBe('90.00');

    // K2 + T1: mesmo payload e referência externa,
    // mas uma chave diferente da que foi registrada.
    //
    // Política adotada: deve retornar conflito.
    const second = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key2)
      .send(payload)
      .expect(409);

    expect(second.body.code).toBe('IDEMPOTENCY_CONFLICT');

    // A tentativa conflitante não pode afetar o saldo.
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
      balance: '90.00',
      version: '2',
    });

    // Apenas uma transação BET deve existir.
    const transactions = await em.execute<
      Array<{ total: number }>
    >(
      `
      SELECT COUNT(*)::int AS total
      FROM wager_transactions
      WHERE wallet_id = ?
        AND kind = 'BET'
      `,
      [walletId],
    );

    expect(transactions[0].total).toBe(1);

    // E exatamente um lançamento DEBIT.
    const ledger = await em.execute<
      Array<{ total: number }>
    >(
      `
      SELECT COUNT(*)::int AS total
      FROM wallet_ledger_entries
      WHERE transaction_id = ?
      `,
      [first.body.transactionId],
    );

    expect(ledger[0].total).toBe(1);
  }, 30000);
});
