import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import ormConfig from '../src/mikro-orm.config.js';
import {
  BettingService,
  type PlaceBetResult,
  type SubmitWagerCommand,
  type WagerKind,
} from '../src/application/services/betting.service.js';

interface WalletFixture {
  playerId: string;
  walletId: string;
  currency: string;
}

interface Payload extends WalletFixture {
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

interface WalletSnapshot {
  balance: string;
  version: string;
  updated_at: string;
  calculated_balance: string;
  entries: number;
  operations: number;
}

describe('Wagering - WIN e LOSS com PostgreSQL real', () => {
  let app: INestApplication<App>;
  let em: EntityManager;
  let independentOrm: MikroORM;

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'jungle_wagering_test') {
      throw new Error('Use DB_NAME=jungle_wagering_test');
    }

    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication();
    await app.init();
    em = app.get(EntityManager);
    independentOrm = await MikroORM.init({ ...ormConfig, dbName: 'jungle_wagering_test' });

    for (const manager of [em, independentOrm.em.fork()]) {
      const rows = await manager.execute<Array<{ name: string }>>(
        'SELECT current_database() AS name',
      );
      expect(rows[0].name).toBe('jungle_wagering_test');
    }
  });

  afterAll(async () => {
    await Promise.all([app?.close(), independentOrm?.close()]);
  });

  async function createWallet(amount = '100.00', currency = 'BRL'): Promise<WalletFixture> {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer()).post('/wallets').send({
      playerId,
      initialBalance: { amount, currency },
    }).expect(201);
    return { playerId, walletId: response.body.id as string, currency };
  }

  function payload(wallet: WalletFixture, kind: WagerKind, amount = '25.00'): Payload {
    return {
      ...wallet,
      providerId: 'Win-Loss-Provider',
      externalTransactionId: randomUUID(),
      roundId: 'Round-Win-Loss',
      gameId: 'Game-Win-Loss',
      kind,
      money: { amount, currency: wallet.currency },
    };
  }

  function command(data: Payload, idempotencyKey: string): SubmitWagerCommand {
    return {
      ...data,
      idempotencyKey,
      amount: data.money.amount,
      currency: data.money.currency,
    };
  }

  async function submit(data: Payload, key: string = randomUUID(), status = 200) {
    return request(app.getHttpServer()).post('/wagering/transactions')
      .set('Idempotency-Key', key).send(data).expect(status);
  }

  async function snapshot(walletId: string): Promise<WalletSnapshot> {
    const rows = await em.execute<WalletSnapshot[]>(`
      SELECT w.balance::text AS balance, w.version::text AS version,
        w.updated_at::text AS updated_at,
        (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
          FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20, 2)::text
          AS calculated_balance,
        (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = w.id)::int AS entries,
        (SELECT COUNT(*) FROM wager_transactions
          WHERE wallet_id = w.id AND kind <> 'OPENING')::int AS operations
      FROM wallets w WHERE w.id = ?
    `, [walletId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].calculated_balance).toBe(rows[0].balance);
    return rows[0];
  }

  async function stored(transactionId: string) {
    const rows = await em.execute<Array<{
      kind: string;
      status: string;
      reference_transaction_id: string | null;
      reference_external_transaction_id: string | null;
      processed_at: Date | null;
      original_response: PlaceBetResult;
    }>>(`
      SELECT kind, status, reference_transaction_id, reference_external_transaction_id,
        processed_at, original_response
      FROM wager_transactions WHERE id = ?
    `, [transactionId]);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function entries(transactionId: string) {
    return em.execute<Array<{
      direction: string;
      amount: string;
      balance_before: string;
      balance_after: string;
    }>>(`
      SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
        balance_after::text AS balance_after
      FROM wallet_ledger_entries WHERE transaction_id = ?
    `, [transactionId]);
  }

  it('WIN credita exatamente, incrementa a versão uma vez e persiste CREDIT e resposta', async () => {
    const wallet = await createWallet();
    const response = await submit(payload(wallet, 'WIN', '25.55'));
    expect(response.body).toMatchObject({
      status: 'PROCESSED', balance: { amount: '125.55', currency: 'BRL' },
      idempotentReplay: false, failureCode: null,
    });
    expect(await snapshot(wallet.walletId)).toMatchObject({
      balance: '125.55', version: '2', entries: 2, operations: 1,
    });
    expect(await entries(response.body.transactionId)).toEqual([{
      direction: 'CREDIT', amount: '25.55', balance_before: '100.00', balance_after: '125.55',
    }]);
    expect(await stored(response.body.transactionId)).toMatchObject({
      kind: 'WIN', status: 'PROCESSED', original_response: {
        transactionId: response.body.transactionId, status: 'PROCESSED', balance: '125.55',
        currency: 'BRL', failureCode: null,
      },
    });
  });

  for (const initialBalance of ['100.00', '0.00']) {
    it(`LOSS processa sem alterar saldo, versão, timestamp ou ledger: ${initialBalance}`, async () => {
      const wallet = await createWallet(initialBalance);
      const before = await snapshot(wallet.walletId);
      const response = await submit(payload(wallet, 'LOSS', '500.00'));
      expect(response.body).toMatchObject({
        status: 'PROCESSED', balance: { amount: initialBalance, currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await snapshot(wallet.walletId)).toEqual({ ...before, operations: 1 });
      expect(await entries(response.body.transactionId)).toEqual([]);
      expect(await stored(response.body.transactionId)).toMatchObject({
        kind: 'LOSS', status: 'PROCESSED', original_response: {
          transactionId: response.body.transactionId, status: 'PROCESSED', balance: initialBalance,
          currency: 'BRL', failureCode: null,
        },
      });
    });
  }

  for (const kind of ['WIN', 'LOSS'] as const) {
    it(`${kind} retorna a resposta original após outra movimentação`, async () => {
      const wallet = await createWallet();
      const data = payload(wallet, kind);
      const key = randomUUID();
      const first = await submit(data, key);
      await submit(payload(wallet, 'BET', '10.00'));
      const beforeReplay = await snapshot(wallet.walletId);
      const replay = await submit(data, key);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await snapshot(wallet.walletId)).toEqual(beforeReplay);
    });

    it(`${kind} rejeita mudança de payload, de kind e aliases não registrados`, async () => {
      const wallet = await createWallet();
      const data = payload(wallet, kind);
      const key = randomUUID();
      await submit(data, key);
      const before = await snapshot(wallet.walletId);
      const changed = await submit({ ...data, money: { ...data.money, amount: '30.00' } }, key, 409);
      const changedKind = await submit({ ...data, kind: kind === 'WIN' ? 'LOSS' : 'WIN' }, key, 409);
      const alias = await submit(data, randomUUID(), 409);
      for (const response of [changed, changedKind, alias]) {
        expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
      }
      expect(await snapshot(wallet.walletId)).toEqual(before);
    });

    it(`${kind} aceita UUIDs em maiúsculas e replay em minúsculas`, async () => {
      const wallet = await createWallet();
      const data = payload(wallet, kind);
      const key = randomUUID();
      const first = await submit({
        ...data, playerId: data.playerId.toUpperCase(), walletId: data.walletId.toUpperCase(),
      }, key);
      const before = await snapshot(wallet.walletId);
      const replay = await submit(data, key);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await snapshot(wallet.walletId)).toEqual(before);
    });

    it(`${kind} mantém a restrição de valor positivo do schema atual`, async () => {
      const wallet = await createWallet();
      const before = await snapshot(wallet.walletId);
      const response = await submit(payload(wallet, kind, '0.00'), randomUUID(), 400);
      expect(response.body.code).toBe('INVALID_MONEY');
      expect(await snapshot(wallet.walletId)).toEqual(before);
    });
  }

  it('duas chamadas WIN idênticas em pools independentes geram apenas um crédito', async () => {
    const wallet = await createWallet();
    const data = command(payload(wallet, 'WIN', '25.55'), randomUUID());
    const serviceA = new BettingService(em.fork());
    const serviceB = new BettingService(independentOrm.em.fork());
    const results = await Promise.all([
      serviceA.submitTransaction(data), serviceB.submitTransaction(data),
    ]);
    expect(results[0].result).toEqual(results[1].result);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(1);
    expect(await snapshot(wallet.walletId)).toMatchObject({
      balance: '125.55', version: '2', entries: 2, operations: 1,
    });
    expect(await entries(results[0].result.transactionId)).toHaveLength(1);
  });

  it('BET, WIN e LOSS concorrentes preservam saldo, versão e ledger', async () => {
    const wallet = await createWallet();
    const serviceA = new BettingService(em.fork());
    const serviceB = new BettingService(independentOrm.em.fork());
    const results = await Promise.all([
      serviceA.submitTransaction(command(payload(wallet, 'BET', '80.00'), randomUUID())),
      serviceB.submitTransaction(command(payload(wallet, 'WIN', '25.00'), randomUUID())),
      serviceB.submitTransaction(command(payload(wallet, 'LOSS', '500.00'), randomUUID())),
    ]);
    expect(results.map((result) => result.result.status)).toEqual([
      'PROCESSED', 'PROCESSED', 'PROCESSED',
    ]);
    expect(await snapshot(wallet.walletId)).toMatchObject({
      balance: '45.00', version: '3', entries: 3, operations: 3,
    });
  });

  it('WIN acima do limite é rejeitado de forma auditável e idempotente', async () => {
    const wallet = await createWallet('999999999999999999.99');
    const data = payload(wallet, 'WIN', '0.01');
    const key = randomUUID();
    const before = await snapshot(wallet.walletId);
    const first = await submit(data, key, 422);
    expect(first.body).toMatchObject({ status: 'REJECTED', failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    const replay = await submit(data, key, 422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await snapshot(wallet.walletId)).toEqual({ ...before, operations: 1 });
    expect(await entries(first.body.transactionId)).toEqual([]);
    expect(await stored(first.body.transactionId)).toMatchObject({ status: 'REJECTED' });
  });

  it('WIN referencia BET sem exigir valor igual nem o mesmo jogo', async () => {
    const wallet = await createWallet();
    const betPayload = payload(wallet, 'BET', '10.00');
    const bet = await submit(betPayload);
    const winPayload = {
      ...payload(wallet, 'WIN', '35.00'), gameId: 'Outro-Jogo',
      referenceExternalTransactionId: betPayload.externalTransactionId,
    };
    const key = randomUUID();
    const win = await submit(winPayload, key);
    expect(win.body.balance.amount).toBe('125.00');
    expect(await stored(win.body.transactionId)).toMatchObject({
      reference_transaction_id: bet.body.transactionId,
      reference_external_transaction_id: betPayload.externalTransactionId,
    });
    const replay = await submit(winPayload, key);
    expect(replay.body).toEqual({ ...win.body, idempotentReplay: true });
    expect(await snapshot(wallet.walletId)).toMatchObject({ balance: '125.00', version: '3' });
    const changedReference = await submit({
      ...winPayload, referenceExternalTransactionId: randomUUID(),
    }, key, 409);
    expect(changedReference.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('WIN não impõe status PROCESSED à BET quando o edital não o exige', async () => {
    const wallet = await createWallet('0.00');
    const betPayload = payload(wallet, 'BET');
    await submit(betPayload, randomUUID(), 422);
    await submit({
      ...payload(wallet, 'WIN'), referenceExternalTransactionId: betPayload.externalTransactionId,
    });
    expect(await snapshot(wallet.walletId)).toMatchObject({
      balance: '25.00', version: '2', entries: 1, operations: 2,
    });
  });

  for (const mismatch of ['round', 'wallet-player', 'currency', 'kind'] as const) {
    it(`WIN rejeita referência incompatível: ${mismatch}`, async () => {
      const wallet = await createWallet();
      const referenceWallet = mismatch === 'wallet-player' || mismatch === 'currency'
        ? await createWallet('100.00', mismatch === 'currency' ? 'USD' : 'BRL')
        : wallet;
      const referencePayload = payload(referenceWallet, mismatch === 'kind' ? 'LOSS' : 'BET', '10.00');
      await submit(referencePayload);
      const data = {
        ...payload(wallet, 'WIN'),
        referenceExternalTransactionId: referencePayload.externalTransactionId,
        ...(mismatch === 'round' ? { roundId: 'Outra-Rodada' } : {}),
      };
      const before = await snapshot(wallet.walletId);
      const key = randomUUID();
      const response = await submit(data, key, 422);
      expect(response.body.failureCode).toBe(
        mismatch === 'kind' ? 'INVALID_REFERENCE_KIND' : 'REFERENCE_MISMATCH',
      );
      expect(await entries(response.body.transactionId)).toEqual([]);
      expect(await snapshot(wallet.walletId)).toEqual({ ...before, operations: before.operations + 1 });
      const replay = await submit(data, key, 422);
      expect(replay.body).toEqual({ ...response.body, idempotentReplay: true });
    });
  }

  for (const otherProvider of [false, true]) {
    it(`WIN sem referência resolvida fica PENDING_REFERENCE; outro provedor: ${otherProvider}`, async () => {
      const wallet = await createWallet();
      const referencePayload = payload(wallet, 'BET', '10.00');
      if (otherProvider) {
        await submit({ ...referencePayload, providerId: 'Outro-Provedor' });
      }
      const data = {
        ...payload(wallet, 'WIN'), referenceExternalTransactionId: referencePayload.externalTransactionId,
      };
      const before = await snapshot(wallet.walletId);
      const key = randomUUID();
      const response = await submit(data, key, 202);
      expect(response.body).toMatchObject({
        status: 'PENDING_REFERENCE', balance: { amount: before.balance, currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await stored(response.body.transactionId)).toMatchObject({
        status: 'PENDING_REFERENCE', reference_transaction_id: null, processed_at: null,
        reference_external_transaction_id: referencePayload.externalTransactionId,
      });
      expect(await entries(response.body.transactionId)).toEqual([]);
      expect(await snapshot(wallet.walletId)).toEqual({ ...before, operations: before.operations + 1 });
      const replay = await submit(data, key, 202);
      expect(replay.body).toEqual({ ...response.body, idempotentReplay: true });
    });
  }
});
