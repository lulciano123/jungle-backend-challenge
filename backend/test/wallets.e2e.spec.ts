
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

describe('WalletsController (e2e)', () => {
  let app: INestApplication<App>;
  let em: EntityManager;

  beforeAll(async () => {
    const moduleFixture: TestingModule =
      await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

    app = moduleFixture.createNestApplication();

    await app.init();

    em = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  it('deve abrir carteira com saldo positivo e persistir o ledger', async () => {
    const playerId = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      })
      .expect(201);

    const walletId = response.body.id as string;

    expect(response.body).toMatchObject({
      playerId,
      balance: {
        amount: '100.00',
        currency: 'BRL',
      },
      version: 1,
    });

    // Confirma a persistência da carteira.
    const wallets = await em.execute(
      `
      SELECT
        id,
        player_id,
        currency,
        balance::text AS balance,
        version::text AS version
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets).toHaveLength(1);

    expect(wallets[0]).toMatchObject({
      id: walletId,
      player_id: playerId,
      currency: 'BRL',
      balance: '100.00',
      version: '1',
    });

    // Confirma o lançamento financeiro.
    const ledger = await em.execute(
      `
      SELECT
        direction,
        amount::text AS amount,
        currency,
        balance_before::text AS balance_before,
        balance_after::text AS balance_after
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(ledger).toHaveLength(1);

    expect(ledger[0]).toMatchObject({
      direction: 'CREDIT',
      amount: '100.00',
      currency: 'BRL',
      balance_before: '0.00',
      balance_after: '100.00',
    });

    // Confirma a transação interna de abertura.
    const transactions = await em.execute(
      `
      SELECT
        kind,
        status,
        amount::text AS amount,
        result_balance::text AS result_balance
      FROM wager_transactions
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(transactions).toHaveLength(1);

    expect(transactions[0]).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '100.00',
      result_balance: '100.00',
    });
  });

  it('deve abrir carteira com saldo zero sem criar ledger', async () => {
    const playerId = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: {
          amount: '0.00',
          currency: 'BRL',
        },
      })
      .expect(201);

    const walletId = response.body.id as string;

    expect(response.body).toMatchObject({
      playerId,
      balance: {
        amount: '0.00',
        currency: 'BRL',
      },
      version: 1,
    });

    const wallets = await em.execute(
      `
      SELECT id
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets).toHaveLength(1);

    const ledger = await em.execute(
      `
      SELECT id
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(ledger).toHaveLength(0);

    const transactions = await em.execute(
      `
      SELECT id
      FROM wager_transactions
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(transactions).toHaveLength(0);
  });

  it('deve rejeitar UUID inválido', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: 'jogador-invalido',
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      })
      .expect(400);

    expect(response.body.code).toBe('INVALID_PLAYER_ID');
  });

  it('deve rejeitar valor monetário inválido', async () => {
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: {
          amount: '1.999',
          currency: 'BRL',
        },
      })
      .expect(400);

    expect(response.body.code).toBe('INVALID_MONEY');
  });

  it('deve rejeitar carteira duplicada para o mesmo jogador e moeda', async () => {
    const playerId = randomUUID();

    const payload = {
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    };

    await request(app.getHttpServer())
      .post('/wallets')
      .send(payload)
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send(payload)
      .expect(409);

    expect(response.body.code).toBe('WALLET_ALREADY_EXISTS');

    // Confirma que existe somente uma carteira.
    const wallets = await em.execute(
      `
      SELECT id
      FROM wallets
      WHERE player_id = ?
        AND currency = 'BRL'
      `,
      [playerId],
    );

    expect(wallets).toHaveLength(1);
  });
});
