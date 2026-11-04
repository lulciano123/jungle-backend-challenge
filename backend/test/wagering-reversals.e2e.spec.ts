import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import type {
  PlaceBetExecution, PlaceBetResult, SubmitWagerCommand, WagerKind,
} from '../src/application/services/betting.service.js';

type ReversalKind = 'REFUND' | 'ROLLBACK';
interface WalletFixture { playerId: string; walletId: string; currency: string }
interface Payload {
  playerId: string;
  walletId: string;
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

describe('Wagering - REFUND e ROLLBACK com PostgreSQL real', () => {
  let app: INestApplication<App>;
  let em: EntityManager;

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'jungle_wagering_test') {
      throw new Error('Use DB_NAME=jungle_wagering_test');
    }
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication();
    await app.init();
    em = app.get(EntityManager);
    const rows = await em.execute<Array<{ name: string }>>('SELECT current_database() AS name');
    expect(rows[0].name).toBe('jungle_wagering_test');
  });

  afterAll(async () => { await app?.close(); });

  async function createWallet(amount = '100.00', currency = 'BRL'): Promise<WalletFixture> {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer()).post('/wallets').send({
      playerId, initialBalance: { amount, currency },
    }).expect(201);
    return { playerId, walletId: response.body.id as string, currency };
  }

  function payload(wallet: WalletFixture, kind: WagerKind, amount = '25.00'): Payload {
    return {
      playerId: wallet.playerId, walletId: wallet.walletId,
      providerId: 'Reversal-Provider', externalTransactionId: `Transaction-${randomUUID()}`,
      roundId: 'Round-Reversal', gameId: 'Game-Reversal', kind,
      money: { amount, currency: wallet.currency },
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

  async function stored(id: string) {
    const rows = await em.execute<Array<{
      kind: string;
      status: string;
      provider_id: string;
      wallet_id: string;
      player_id: string;
      round_id: string;
      game_id: string;
      amount: string;
      currency: string;
      payload_hash: string;
      idempotency_key: string;
      reference_transaction_id: string | null;
      reference_external_transaction_id: string | null;
      failure_code: string | null;
      processed_at: Date | null;
      original_response: PlaceBetResult;
    }>>(`
      SELECT kind, status, provider_id, wallet_id, player_id, round_id, game_id,
        amount::text AS amount, currency, payload_hash, idempotency_key,
        reference_transaction_id, reference_external_transaction_id,
        failure_code, processed_at, original_response
      FROM wager_transactions WHERE id = ?
    `, [id]);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function entries(id: string) {
    return em.execute<Array<{
      direction: string; amount: string; balance_before: string; balance_after: string;
    }>>(`
      SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
        balance_after::text AS balance_after
      FROM wallet_ledger_entries WHERE transaction_id = ?
    `, [id]);
  }

  async function original(kind: WagerKind = 'BET') {
    const wallet = await createWallet();
    const data = payload(wallet, kind);
    if (kind === 'REFUND' || kind === 'ROLLBACK') {
      const bet = payload(wallet, 'BET');
      await submit(bet);
      data.referenceExternalTransactionId = bet.externalTransactionId;
    }
    const response = await submit(data);
    return { wallet, data, response };
  }

  function reversal(wallet: WalletFixture, kind: ReversalKind, reference: Payload): Payload {
    return {
      ...payload(wallet, kind, reference.money.amount),
      referenceExternalTransactionId: reference.externalTransactionId,
    };
  }

  async function expectRejected(data: Payload, failureCode: string, key: string = randomUUID()) {
    const before = await snapshot(data.walletId);
    const response = await submit(data, key, 422);
    expect(response.body).toMatchObject({
      status: 'REJECTED', code: failureCode, failureCode,
      balance: { amount: before.balance, currency: data.money.currency },
      idempotentReplay: false,
    });
    expect(await entries(response.body.transactionId)).toEqual([]);
    expect(await snapshot(data.walletId)).toEqual({ ...before, operations: before.operations + 1 });
    expect(await stored(response.body.transactionId)).toMatchObject({
      status: 'REJECTED', failure_code: failureCode,
      original_response: {
        transactionId: response.body.transactionId, status: 'REJECTED',
        balance: before.balance, currency: data.money.currency, failureCode,
      },
    });
    return response;
  }

  it.each([
    ['REFUND', 'BET', '100.00', '3', '75.00', 'CREDIT'],
    ['ROLLBACK', 'BET', '100.00', '3', '75.00', 'CREDIT'],
    ['ROLLBACK', 'WIN', '100.00', '3', '125.00', 'DEBIT'],
    ['ROLLBACK', 'REFUND', '75.00', '4', '100.00', 'DEBIT'],
  ] as const)('%s válido sobre %s aplica uma única entrada invertida', async (
    kind, referenceKind, finalBalance, version, balanceBefore, direction,
  ) => {
    const { wallet, data, response: reference } = await original(referenceKind);
    const operation = reversal(wallet, kind, data);
    // A referência externa permanece textual; só os UUIDs da wallet/jogador são canônicos.
    operation.playerId = operation.playerId.toUpperCase();
    operation.walletId = operation.walletId.toUpperCase();
    operation.gameId = 'Outro-Jogo';
    const response = await submit(operation);
    expect(response.body).toMatchObject({
      status: 'PROCESSED', balance: { amount: finalBalance, currency: 'BRL' },
      failureCode: null, idempotentReplay: false,
    });
    expect(await snapshot(wallet.walletId)).toMatchObject({ balance: finalBalance, version });
    expect(await entries(response.body.transactionId)).toEqual([{
      direction, amount: '25.00', balance_before: balanceBefore, balance_after: finalBalance,
    }]);
    expect(await stored(response.body.transactionId)).toMatchObject({
      kind, status: 'PROCESSED', reference_transaction_id: reference.body.transactionId,
      reference_external_transaction_id: data.externalTransactionId,
      wallet_id: wallet.walletId, player_id: wallet.playerId,
      original_response: {
        transactionId: response.body.transactionId, status: 'PROCESSED',
        balance: finalBalance, currency: 'BRL', failureCode: null,
      },
    });
  });

  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    for (const reference of [undefined, null, '', '   ', 123]) {
      it(`${kind} exige referência externa válida: ${JSON.stringify(reference)}`, async () => {
        const wallet = await createWallet();
        const data = payload(wallet, kind);
        const before = await snapshot(wallet.walletId);
        const response = await request(app.getHttpServer()).post('/wagering/transactions')
          .set('Idempotency-Key', randomUUID())
          .send({ ...data, referenceExternalTransactionId: reference }).expect(400);
        expect(response.body.code).toBe(reference === undefined ? 'MISSING_REFERENCE' : 'INVALID_REFERENCE');
        expect(await snapshot(wallet.walletId)).toEqual(before);
      });
    }

    it(`${kind} rejeita BET não processada`, async () => {
      const wallet = await createWallet();
      const bet = payload(wallet, 'BET', '150.00');
      await submit(bet, randomUUID(), 422);
      await expectRejected(reversal(wallet, kind, bet), 'REFERENCE_NOT_PROCESSED');
    });

    for (const amount of ['24.99', '25.01']) {
      it(`${kind} rejeita valor diferente da referência: ${amount}`, async () => {
        const { wallet, data } = await original();
        await expectRejected({
          ...reversal(wallet, kind, data), money: { amount, currency: 'BRL' },
        }, 'REFERENCE_AMOUNT_MISMATCH');
      });
    }

    it(`${kind} mantém replay, hash canônico e associação entre chave e referência externa`, async () => {
      const { wallet, data } = await original();
      const operation = reversal(wallet, kind, data);
      const key = `Key-${randomUUID()}`;
      const first = await submit(operation, key);
      await submit(payload(wallet, 'WIN', '10.00'));
      const before = await snapshot(wallet.walletId);
      const replay = await submit({
        ...operation, playerId: operation.playerId.toUpperCase(), walletId: operation.walletId.toUpperCase(),
      }, key);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      const changedReference = await submit({
        ...operation, referenceExternalTransactionId: randomUUID(),
      }, key, 409);
      const changedAmount = await submit({
        ...operation, money: { amount: '24.99', currency: 'BRL' },
      }, key, 409);
      const alias = await submit(operation, randomUUID(), 409);
      for (const response of [changedReference, changedAmount, alias]) {
        expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
      }
      expect(await snapshot(wallet.walletId)).toEqual(before);
    });

    it(`${kind} distinto repetido é rejeitado e não gera outra movimentação`, async () => {
      const { wallet, data } = await original();
      await submit(reversal(wallet, kind, data));
      const duplicate = reversal(wallet, kind, data);
      const key = randomUUID();
      const rejected = await expectRejected(duplicate, 'REFERENCE_ALREADY_REVERSED', key);
      const beforeReplay = await snapshot(wallet.walletId);
      const replay = await submit(duplicate, key, 422);
      expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
      expect(await snapshot(wallet.walletId)).toEqual(beforeReplay);
    });

    for (const mismatch of ['round', 'wallet-player', 'currency'] as const) {
      it(`${kind} rejeita referência com ${mismatch} incompatível`, async () => {
        const { wallet, data } = await original();
        const target = mismatch === 'round' ? wallet
          : await createWallet('100.00', mismatch === 'currency' ? 'USD' : 'BRL');
        const operation = reversal(target, kind, data);
        operation.money.currency = target.currency;
        if (mismatch === 'round') operation.roundId = 'Outra-Rodada';
        await expectRejected(operation, 'REFERENCE_MISMATCH');
      });
    }

    for (const existsInOtherProvider of [false, true]) {
      it(`${kind} preserva PENDING_REFERENCE; referência em outro provedor: ${existsInOtherProvider}`, async () => {
        const wallet = await createWallet();
        const reference = payload(wallet, 'BET');
        if (existsInOtherProvider) await submit({ ...reference, providerId: 'Outro-Provedor' });
        const operation = reversal(wallet, kind, reference);
        const key = randomUUID();
        const before = await snapshot(wallet.walletId);
        const response = await submit(operation, key, 202);
        expect(response.body).toMatchObject({
          status: 'PENDING_REFERENCE', balance: { amount: before.balance, currency: 'BRL' },
        });
        const row = await stored(response.body.transactionId);
        expect(row).toMatchObject({
          kind, status: 'PENDING_REFERENCE', provider_id: operation.providerId,
          player_id: wallet.playerId, wallet_id: wallet.walletId,
          round_id: operation.roundId, game_id: operation.gameId,
          amount: operation.money.amount, currency: operation.money.currency,
          idempotency_key: key, reference_external_transaction_id: reference.externalTransactionId,
          reference_transaction_id: null, processed_at: null,
        });
        expect(row.payload_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(row.original_response).toMatchObject({ status: 'PENDING_REFERENCE', balance: before.balance });
        expect(await entries(response.body.transactionId)).toEqual([]);
        expect(await snapshot(wallet.walletId)).toEqual({ ...before, operations: before.operations + 1 });
        const replay = await submit(operation, key, 202);
        expect(replay.body).toEqual({ ...response.body, idempotentReplay: true });
      });
    }

    it(`${kind} não ultrapassa o limite monetário ao creditar`, async () => {
      const { wallet, data } = await original();
      await submit(payload(wallet, 'WIN', '999999999999999924.99'));
      await expectRejected(reversal(wallet, kind, data), 'BALANCE_LIMIT_EXCEEDED');
    });

    it(`${kind} processado é único por referência também no índice SQL`, async () => {
      const { wallet, data, response: reference } = await original();
      await submit(reversal(wallet, kind, data));
      const before = await snapshot(wallet.walletId);
      await expect(em.transactional(async (tx) => {
        await tx.execute(`
          INSERT INTO wager_transactions (
            id, wallet_id, player_id, provider_id, external_transaction_id,
            idempotency_key, payload_hash, round_id, game_id, kind, status,
            amount, currency, reference_external_transaction_id, reference_transaction_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSED', ?::numeric, ?, ?, ?)
        `, [
          randomUUID(), wallet.walletId, wallet.playerId, data.providerId, randomUUID(),
          randomUUID(), 'a'.repeat(64), data.roundId, data.gameId, kind,
          data.money.amount, wallet.currency, data.externalTransactionId, reference.body.transactionId,
        ]);
        throw new Error('DUPLICATE_REVERSAL_WAS_ACCEPTED');
      })).rejects.toThrow('wager_transactions_reversal_unique');
      expect(await snapshot(wallet.walletId)).toEqual(before);
    });
  }

  it.each([
    ['REFUND', 'WIN'], ['REFUND', 'LOSS'], ['REFUND', 'REFUND'],
    ['ROLLBACK', 'LOSS'], ['ROLLBACK', 'ROLLBACK'],
  ] as const)('%s rejeita referência de kind %s', async (kind, referenceKind) => {
    const { wallet, data } = await original(referenceKind);
    await expectRejected(reversal(wallet, kind, data), 'INVALID_REFERENCE_KIND');
  });

  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    it(`${kind} rejeita referência OPENING`, async () => {
      const wallet = await createWallet();
      await expectRejected({
        ...payload(wallet, kind), providerId: '__internal__',
        referenceExternalTransactionId: `opening:${wallet.walletId}`,
      }, 'INVALID_REFERENCE_KIND');
    });
  }

  it.each([
    ['WIN', '120.00'], ['REFUND', '95.00'],
  ] as const)('ROLLBACK de %s sem saldo é auditável e usa failureCode específico', async (referenceKind, spent) => {
    const { wallet, data } = await original(referenceKind);
    await submit(payload(wallet, 'BET', spent));
    const operation = reversal(wallet, 'ROLLBACK', data);
    const key = randomUUID();
    const rejected = await expectRejected(operation, 'REVERSAL_INSUFFICIENT_FUNDS', key);
    expect(rejected.body.balance.amount).toBe('5.00');
    await submit(payload(wallet, 'WIN', '25.00'));
    const beforeReplay = await snapshot(wallet.walletId);
    const replay = await submit(operation, key, 422);
    expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
    expect(await snapshot(wallet.walletId)).toEqual(beforeReplay);
    // Uma rejeição não consome a unicidade reservada apenas às reversões PROCESSED.
    await submit({ ...operation, externalTransactionId: randomUUID() });
    expect(await snapshot(wallet.walletId)).toMatchObject({ balance: '5.00' });
  });

  it('REFUND e ROLLBACK podem reverter a mesma BET uma vez por tipo', async () => {
    const { wallet, data, response: reference } = await original();
    await submit(reversal(wallet, 'REFUND', data));
    await submit(reversal(wallet, 'ROLLBACK', data));
    expect(await snapshot(wallet.walletId)).toMatchObject({ balance: '125.00', version: '4', entries: 4 });
    const rows = await em.execute<Array<{ kind: string; total: number }>>(`
      SELECT kind, COUNT(*)::int AS total FROM wager_transactions
      WHERE reference_transaction_id = ? AND status = 'PROCESSED' GROUP BY kind ORDER BY kind
    `, [reference.body.transactionId]);
    expect(rows).toEqual([{ kind: 'REFUND', total: 1 }, { kind: 'ROLLBACK', total: 1 }]);
  });

  async function concurrentProcesses(commands: SubmitWagerCommand[]): Promise<PlaceBetExecution[]> {
    // Cada processo tem seu próprio ORM/pool. A barreira libera os três após conectarem ao banco.
    const script = `
      import { MikroORM } from '@mikro-orm/postgresql';
      import config from './src/mikro-orm.config.ts';
      import { BettingService } from './src/application/services/betting.service.ts';
      if (process.env.DB_NAME !== 'jungle_wagering_test') throw new Error('TEST_DATABASE_REQUIRED');
      const orm = await MikroORM.init({ ...config, dbName: 'jungle_wagering_test' });
      try {
        const rows = await orm.em.fork().execute('SELECT current_database() AS name');
        if (rows[0].name !== 'jungle_wagering_test') throw new Error('WRONG_DATABASE');
        const go = new Promise(resolve => process.stdin.once('data', resolve));
        console.log('READY');
        await go;
        const result = await new BettingService(orm.em.fork()).submitTransaction(
          JSON.parse(process.env.REVERSAL_TEST_COMMAND)
        );
        console.log('RESULT:' + JSON.stringify(result));
      } finally { await orm.close(); }
    `;
    const children = commands.map((command) => {
      const child = spawn(process.execPath, ['--eval', script], {
        cwd: process.cwd(), timeout: 20000,
        env: { ...process.env, DB_NAME: 'jungle_wagering_test', REVERSAL_TEST_COMMAND: JSON.stringify(command) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const ready = new Promise<void>((resolve, reject) => {
        let announced = false;
        child.once('error', reject);
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
          if (!announced && stdout.includes('READY\n')) { announced = true; resolve(); }
        });
        child.once('close', () => { if (!announced) reject(new Error(stderr || 'PROCESS_NOT_READY')); });
      });
      const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      return { child, ready, finished };
    });
    try {
      await Promise.all(children.map((entry) => entry.ready));
      for (const { child } of children) child.stdin.end('GO\n');
      const results = await Promise.all(children.map((entry) => entry.finished));
      return results.map((result) => {
        expect(result.code, result.stderr).toBe(0);
        const line = result.stdout.split('\n').find((value) => value.startsWith('RESULT:'));
        if (!line) throw new Error('PROCESS_RESULT_MISSING');
        return JSON.parse(line.slice('RESULT:'.length)) as PlaceBetExecution;
      });
    } finally {
      for (const { child } of children) {
        if (!child.stdin.writableEnded) child.stdin.end();
        if (child.exitCode === null && !child.killed) child.kill();
      }
    }
  }

  for (const [kind, referenceKind, balance, version, entryCount, operationCount] of [
    ['REFUND', 'BET', '100.00', '3', 3, 4],
    ['ROLLBACK', 'BET', '100.00', '3', 3, 4],
    ['ROLLBACK', 'WIN', '100.00', '3', 3, 4],
    ['ROLLBACK', 'REFUND', '75.00', '4', 4, 5],
  ] as const) {
    it(`${kind} sobre ${referenceKind} simultâneo em três processos produz apenas uma reversão`, async () => {
      const { wallet, data, response: reference } = await original(referenceKind);
      const commands = Array.from({ length: 3 }, (): SubmitWagerCommand => ({
        ...reversal(wallet, kind, data), idempotencyKey: randomUUID(),
        amount: data.money.amount, currency: data.money.currency,
      }));
      const results = await concurrentProcesses(commands);
      expect(results.filter((execution) => execution.result.status === 'PROCESSED')).toHaveLength(1);
      const rejected = results.filter((execution) => execution.result.status === 'REJECTED');
      expect(rejected).toHaveLength(2);
      for (const result of rejected) expect(result.result.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      expect(await snapshot(wallet.walletId)).toMatchObject({
        balance, version, entries: entryCount, operations: operationCount,
      });
      const rows = await em.execute<Array<{ status: string; total: number }>>(`
        SELECT status, COUNT(*)::int AS total FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind = ? GROUP BY status ORDER BY status
      `, [reference.body.transactionId, kind]);
      expect(rows).toEqual([{ status: 'PROCESSED', total: 1 }, { status: 'REJECTED', total: 2 }]);
    }, 30000);
  }

  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    it(`${kind} idêntico em três processos aplica um único efeito e retorna replay`, async () => {
      const { wallet, data } = await original();
      const operation = reversal(wallet, kind, data);
      const command: SubmitWagerCommand = {
        ...operation, idempotencyKey: randomUUID(), amount: data.money.amount, currency: wallet.currency,
      };
      const results = await concurrentProcesses([command, command, command]);
      for (const result of results) {
        expect(result.result.status).toBe('PROCESSED');
        expect(result.result).toEqual(results[0].result);
      }
      expect(results.filter((result) => result.idempotentReplay)).toHaveLength(2);
      expect(await snapshot(wallet.walletId)).toMatchObject({
        balance: '100.00', version: '3', entries: 3, operations: 2,
      });
      expect(await entries(results[0].result.transactionId)).toHaveLength(1);
    }, 30000);
  }
});
