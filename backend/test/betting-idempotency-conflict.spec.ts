
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../src/mikro-orm.config.js';
import {
  BettingService,
  type PlaceBetCommand,
} from '../src/application/services/betting.service.js';

const TEST_DATABASE = 'jungle_wagering_test';

interface WalletRow {
  id: string;
  balance: string;
  version: string;
}

interface CountRow {
  total: number;
}

describe('BettingService - Conflitos de idempotência', () => {
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

  it('deve rejeitar conflito global sem debitar duas carteiras', async () => {
    const walletA = randomUUID();
    const walletB = randomUUID();
    const playerA = randomUUID();
    const playerB = randomUUID();

    await ormA.em.fork().execute(
      `
      INSERT INTO wallets (id, player_id, currency, balance)
      VALUES
        (?, ?, 'BRL', 100.00),
        (?, ?, 'BRL', 100.00)
      `,
      [walletA, playerA, walletB, playerB],
    );

    const sharedKey = randomUUID();

    const commandA: PlaceBetCommand = {
      walletId: walletA,
      playerId: playerA,
      providerId: 'conflict-test-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: sharedKey,
      amount: '80.00',
      currency: 'BRL',
    };

    const commandB: PlaceBetCommand = {
      walletId: walletB,
      playerId: playerB,
      providerId: 'conflict-test-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: sharedKey,
      amount: '80.00',
      currency: 'BRL',
    };

    const serviceA = new BettingService(ormA.em.fork());
    const serviceB = new BettingService(ormB.em.fork());

    // Captura tanto aprovações quanto erros.
    const results = await Promise.allSettled([
      serviceA.placeBet(commandA),
      serviceB.placeBet(commandB),
    ]);

    const success = results.filter(
      (result) => result.status === 'fulfilled',
    );

    const failures = results.filter(
      (result) => result.status === 'rejected',
    );

    expect(success).toHaveLength(1);
    expect(failures).toHaveLength(1);

    if (success[0].status === 'fulfilled') {
      expect(success[0].value.status).toBe('PROCESSED');
    }

    const wallets = await ormA.em.fork().execute<WalletRow[]>(
      `
      SELECT
        id,
        balance::text AS balance,
        version::text AS version
      FROM wallets
      WHERE id IN (?, ?)
      `,
      [walletA, walletB],
    );

    expect(wallets).toHaveLength(2);

    // Uma carteira debitada; outra intacta.
    expect(wallets.map((w) => w.balance).sort()).toEqual([
      '100.00',
      '20.00',
    ].sort());

    expect(wallets.map((w) => w.version).sort()).toEqual([
      '1',
      '2',
    ]);

    const transactions = await ormA.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wager_transactions
      WHERE idempotency_key = ?
      `,
      [sharedKey],
    );

    expect(transactions[0].total).toBe(1);

    const ledger = await ormA.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wallet_ledger_entries
      WHERE wallet_id IN (?, ?)
      `,
      [walletA, walletB],
    );

    expect(ledger[0].total).toBe(1);

    // O erro precisa ser uma mensagem de domínio,
    // não uma violação SQL exposta ao consumidor.
    if (failures[0].status === 'rejected') {
      expect(String(failures[0].reason))
        .toContain('Conflito de idempotência');
    }
  }, 30000);
});
