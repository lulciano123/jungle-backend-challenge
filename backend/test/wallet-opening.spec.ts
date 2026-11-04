import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../src/mikro-orm.config.js';
import {
  WalletsService,
  WalletAlreadyExistsError,
} from '../src/application/services/wallets.service.js';

const TEST_DATABASE = 'jungle_wagering_test';

interface WalletRow {
  balance: string;
  version: string;
}

interface OpeningRow {
  kind: string;
  status: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
}

interface CountRow {
  total: number;
}

describe('WalletsService - Abertura de carteiras', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      ...ormConfig,
      dbName: TEST_DATABASE,
    });

    const rows = await orm.em.fork().execute<
      Array<{ database_name: string }>
    >('SELECT current_database() AS database_name');

    expect(rows[0].database_name).toBe(TEST_DATABASE);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  it('deve gerar OPENING e CREDIT para saldo inicial positivo', async () => {
    const service = new WalletsService(orm.em.fork());

    const result = await service.open({
      playerId: randomUUID(),
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    expect(result.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(result.version).toBe(1);

    const wallets = await orm.em.fork().execute<WalletRow[]>(
      `
      SELECT
        balance::text AS balance,
        version::text AS version
      FROM wallets
      WHERE id = ?
      `,
      [result.id],
    );

    expect(wallets).toHaveLength(1);
    expect(wallets[0].balance).toBe('100.00');
    expect(wallets[0].version).toBe('1');

    const opening = await orm.em.fork().execute<OpeningRow[]>(
      `
      SELECT
        t.kind,
        t.status,
        l.direction,
        l.amount::text AS amount,
        l.balance_before::text AS balance_before,
        l.balance_after::text AS balance_after
      FROM wager_transactions t
      JOIN wallet_ledger_entries l
        ON l.transaction_id = t.id
      WHERE t.wallet_id = ?
      `,
      [result.id],
    );

    expect(opening).toEqual([
      {
        kind: 'OPENING',
        status: 'PROCESSED',
        direction: 'CREDIT',
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
      },
    ]);
  });

  it('não deve gerar lançamento para saldo inicial zero', async () => {
    const service = new WalletsService(orm.em.fork());

    const result = await service.open({
      playerId: randomUUID(),
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    expect(result.balance.amount).toBe('0.00');
    expect(result.version).toBe(1);

    const entries = await orm.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [result.id],
    );

    expect(entries[0].total).toBe(0);
  });

  it('deve impedir carteira duplicada para jogador e moeda', async () => {
    const playerId = randomUUID();

    const service = new WalletsService(orm.em.fork());

    const command = {
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    };

    const original = await service.open(command);

    await expect(service.open(command))
      .rejects.toThrow(WalletAlreadyExistsError);

    const wallets = await orm.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wallets
      WHERE player_id = ?
        AND currency = 'BRL'
      `,
      [playerId],
    );

    expect(wallets[0].total).toBe(1);

    const entries = await orm.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [original.id],
    );

    expect(entries[0].total).toBe(1);
  });
});
