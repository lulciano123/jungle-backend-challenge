
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../src/mikro-orm.config.js';
import {
  BettingService,
  type PlaceBetCommand,
} from '../src/application/services/betting.service.js';

interface WalletRow {
  balance: string;
  version: string;
}

interface CountRow {
  total: number;
}

interface TransactionRow {
  status: string;
  original_response: {
    transactionId: string;
    status: string;
    balance: string;
    currency: string;
    failureCode: string | null;
  };
}

const TEST_DATABASE = 'jungle_wagering_test';

describe('BettingService - Idempotência concorrente', () => {
  let ormA: MikroORM;
  let ormB: MikroORM;

  beforeAll(async () => {
    const config = {
      ...ormConfig,
      dbName: TEST_DATABASE,
    };

    [ormA, ormB] = await Promise.all([
      MikroORM.init(config),
      MikroORM.init(config),
    ]);

    for (const orm of [ormA, ormB]) {
      const rows = await orm.em.fork().execute<
        Array<{ database_name: string }>
      >('SELECT current_database() AS database_name');

      expect(rows[0].database_name).toBe(TEST_DATABASE);
    }
  });

  afterAll(async () => {
    await Promise.all([
      ormA?.close(),
      ormB?.close(),
    ]);
  });

  it('deve processar somente uma de 50 chamadas idênticas', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Cria uma carteira e confirma a inserção.
    await ormA.em.fork().execute(
      `
      INSERT INTO wallets (
        id, player_id, currency, balance
      )
      VALUES (?, ?, 'BRL', 100.00)
      `,
      [walletId, playerId],
    );

    // Todas as 50 chamadas terão exatamente
    // os mesmos dados e a mesma chave.
    const command: PlaceBetCommand = {
      walletId,
      playerId,
      providerId: 'idempotency-concurrency-test',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '80.00',
      currency: 'BRL',
    };

    const serviceA = new BettingService(ormA.em.fork());
    const serviceB = new BettingService(ormB.em.fork());

    // Dispara 50 chamadas sem esperar uma pela outra.
    // Alternamos entre dois pools independentes.
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const service = index % 2 === 0
          ? serviceA
          : serviceB;

        return service.placeBet(command);
      }),
    );

    expect(results).toHaveLength(50);

    const original = results[0];

    expect(original.status).toBe('PROCESSED');
    expect(original.balance).toBe('20.00');
    expect(original.failureCode).toBeNull();

    // Todas precisam devolver exatamente
    // a mesma resposta, inclusive transactionId.
    for (const result of results) {
      expect(result).toEqual(original);
    }

    // Verifica o saldo persistido após os COMMITs.
    const wallets = await ormA.em.fork().execute<WalletRow[]>(
      `
      SELECT
        balance::text AS balance,
        version::text AS version
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets).toHaveLength(1);
    expect(wallets[0].balance).toBe('20.00');
    expect(wallets[0].version).toBe('2');

    // Deve existir exatamente uma transação.
    const transactions = await ormA.em.fork().execute<
      CountRow[]
    >(
      `
      SELECT COUNT(*)::int AS total
      FROM wager_transactions
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(transactions[0].total).toBe(1);

    // A resposta original precisa estar persistida.
    const stored = await ormA.em.fork().execute<
      TransactionRow[]
    >(
      `
      SELECT status, original_response
      FROM wager_transactions
      WHERE id = ?
      `,
      [original.transactionId],
    );

    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('PROCESSED');
    expect(stored[0].original_response).toEqual(original);

    // Somente um lançamento financeiro.
    const ledger = await ormA.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(ledger[0].total).toBe(1);
  }, 30000);
});
