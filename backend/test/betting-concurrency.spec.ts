
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

const TEST_DATABASE = 'jungle_wagering_test';

describe('BettingService - Concorrência real', () => {
  let ormA: MikroORM;
  let ormB: MikroORM;

  beforeAll(async () => {
    // Duas instâncias independentes do ORM.
    // A configuração explícita impede escrita
    // acidental no banco principal da aplicação.
    const config = {
      ...ormConfig,
      dbName: TEST_DATABASE,
    };

    [ormA, ormB] = await Promise.all([
      MikroORM.init(config),
      MikroORM.init(config),
    ]);

    // Verificação adicional de segurança.
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

  it('deve aprovar apenas uma de duas apostas concorrentes', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Cria uma carteira no banco de testes.
    // O INSERT é confirmado antes das apostas.
    await ormA.em.fork().execute(
      `
      INSERT INTO wallets (
        id, player_id, currency, balance
      )
      VALUES (?, ?, 'BRL', 100.00)
      `,
      [walletId, playerId],
    );

    const baseCommand = {
      walletId,
      playerId,
      providerId: 'concurrency-test-provider',
      amount: '80.00',
      currency: 'BRL',
    };

    // São duas apostas diferentes.
    // Portanto, possuem referências e
    // chaves de idempotência diferentes.
    const commandA: PlaceBetCommand = {
      ...baseCommand,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    };

    const commandB: PlaceBetCommand = {
      ...baseCommand,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    };

    // Serviços independentes acessando o mesmo banco.
    const serviceA = new BettingService(ormA.em.fork());
    const serviceB = new BettingService(ormB.em.fork());

    // Dispara as duas operações concorrentemente.
    const [resultA, resultB] = await Promise.all([
      serviceA.placeBet(commandA),
      serviceB.placeBet(commandB),
    ]);

    // Não importa qual aposta ganhou a disputa.
    // Exatamente uma deve ser processada.
    const statuses = [resultA.status, resultB.status].sort();

    expect(statuses).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);

    const approved = [resultA, resultB].find(
      (result) => result.status === 'PROCESSED',
    );

    const rejected = [resultA, resultB].find(
      (result) => result.status === 'REJECTED',
    );

    expect(approved?.balance).toBe('20.00');
    expect(rejected?.balance).toBe('20.00');
    expect(rejected?.failureCode).toBe('INSUFFICIENT_FUNDS');

    // Consulta novamente o banco após os dois COMMITs.
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

    // A versão só pode ter avançado uma vez.
    expect(wallets[0].version).toBe('2');

    // Devem existir duas decisões financeiras:
    // uma aprovação e uma rejeição.
    const transactions = await ormA.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wager_transactions
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(transactions[0].total).toBe(2);

    // Mas apenas um débito deve existir no ledger.
    const ledger = await ormA.em.fork().execute<CountRow[]>(
      `
      SELECT COUNT(*)::int AS total
      FROM wallet_ledger_entries
      WHERE wallet_id = ?
      `,
      [walletId],
    );

    expect(ledger[0].total).toBe(1);
  });
});
