
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

describe('BettingService - Rollback financeiro', () => {
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

  it.each([
    ['BET', '20.00'],
    ['WIN', '180.00'],
  ] as const)('deve desfazer tudo se o ledger de %s falhar', async (kind, finalBalance) => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    const command: PlaceBetCommand = {
      walletId,
      playerId,
      providerId: 'rollback-test-provider',
      roundId: 'round-rollback-test',
      gameId: 'game-rollback-test',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '80.00',
      currency: 'BRL',
    };

    const db = orm.em.fork();

    // Carteira criada e confirmada antes do teste.
    await db.execute(
      `
      INSERT INTO wallets (
        id, player_id, currency, balance
      )
      VALUES (?, ?, 'BRL', 100.00)
      `,
      [walletId, playerId],
    );

    // Identificadores únicos para evitar colisões
    // com outros testes no mesmo banco.
    const suffix = randomUUID().replaceAll('-', '');

    const functionName = `test_fail_ledger_${suffix}`;
    const triggerName = `trg_fail_ledger_${suffix}`;

    let functionCreated = false;
    let triggerCreated = false;

    try {
      // Função de falha proposital.
      // Só afeta a carteira criada por este teste.
      await db.execute(`
        CREATE FUNCTION ${functionName}()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW.wallet_id = '${walletId}'::uuid THEN
            RAISE EXCEPTION 'INJECTED_LEDGER_FAILURE';
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);

      functionCreated = true;

      // Intercepta a tentativa de inserir um ledger.
      await db.execute(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}()
      `);

      triggerCreated = true;

      // Executa o serviço real contra o PostgreSQL.
      const service = new BettingService(orm.em.fork());

      let capturedError: unknown;

      try {
        await service.submitTransaction({ ...command, kind });
      } catch (error) {
        capturedError = error;
      }

      // A falha precisa ter ocorrido no ledger.
      expect(capturedError).toBeDefined();

      expect(String(capturedError))
        .toContain('INJECTED_LEDGER_FAILURE');

      // Verifica os dados usando outra conexão,
      // depois que a transação falhou.
      const verify = orm.em.fork();

      const wallets = await verify.execute<WalletRow[]>(
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

      // O débito anterior à falha deve ser desfeito.
      expect(wallets[0].balance).toBe('100.00');
      expect(wallets[0].version).toBe('1');

      const transactions = await verify.execute<CountRow[]>(
        `
        SELECT COUNT(*)::int AS total
        FROM wager_transactions
        WHERE idempotency_key = ?
        `,
        [command.idempotencyKey],
      );

      // A transação financeira também deve desaparecer.
      expect(transactions[0].total).toBe(0);

      const ledger = await verify.execute<CountRow[]>(
        `
        SELECT COUNT(*)::int AS total
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
        `,
        [walletId],
      );

      expect(ledger[0].total).toBe(0);
    } finally {
      // Remove a falha injetada mesmo se o teste falhar.
      // Nunca remove os triggers reais de imutabilidade.
      if (triggerCreated) {
        await db.execute(`
          DROP TRIGGER IF EXISTS ${triggerName}
          ON wallet_ledger_entries
        `);
      }

      if (functionCreated) {
        await db.execute(`
          DROP FUNCTION IF EXISTS ${functionName}()
        `);
      }
    }

    // Depois da limpeza, a MESMA aposta deve
    // funcionar: a falha anterior não pode ter
    // consumido a chave de idempotência.
    const retryService = new BettingService(orm.em.fork());

    const { result } = await retryService.submitTransaction({ ...command, kind });

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe(finalBalance);
    expect(result.failureCode).toBeNull();

    const verify = orm.em.fork();

    const wallets = await verify.execute<WalletRow[]>(
      `
      SELECT
        balance::text AS balance,
        version::text AS version
      FROM wallets
      WHERE id = ?
      `,
      [walletId],
    );

    expect(wallets[0].balance).toBe(finalBalance);
    expect(wallets[0].version).toBe('2');

    const ledger = await verify.execute<CountRow[]>(
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
