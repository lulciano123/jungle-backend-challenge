
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../src/mikro-orm.config.js';
import {
  BettingService,
  type PlaceBetCommand,
} from '../src/application/services/betting.service.js';

interface WalletRow {
  balance: string;
  version: string;
}

interface TransactionRow {
  status: string;
  original_response: {
    transactionId: string;
    status: string;
    balance: string;
  };
}

interface LedgerRow {
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
}

describe('BettingService - Integração com PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  // Cada teste cria dados em uma transação externa.
  // No final, essa transação sofre ROLLBACK.
  // Assim, não precisamos apagar linhas do ledger imutável.
  async function withTestWallet(
    test: (
      em: EntityManager,
      command: PlaceBetCommand,
    ) => Promise<void>,
  ): Promise<void> {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const rollbackMarker = new Error('ROLLBACK_TEST_DATA');

    const em = orm.em.fork();

    const command: PlaceBetCommand = {
      walletId,
      playerId,
      providerId: 'integration-test-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '80.00',
      currency: 'BRL',
    };

    try {
      await em.transactional(async (tx) => {
        await tx.execute(
          `
          INSERT INTO wallets (
            id, player_id, currency, balance
          )
          VALUES (?, ?, 'BRL', 100.00)
          `,
          [walletId, playerId],
        );

        await test(tx, command);

        // Força ROLLBACK mesmo após um teste aprovado.
        throw rollbackMarker;
      });
    } catch (error) {
      // Somente o rollback intencional é aceito.
      // Qualquer falha real deve reprovar o teste.
      if (error !== rollbackMarker) {
        throw error;
      }
    }
  }

  it('deve registrar aposta, saldo e ledger atomicamente', async () => {
    await withTestWallet(async (em, command) => {
      const service = new BettingService(em);

      const result = await service.placeBet(command);

      expect(result).toMatchObject({
        status: 'PROCESSED',
        balance: '20.00',
        currency: 'BRL',
        failureCode: null,
      });

      const wallets = await em.execute<WalletRow[]>(
        `
        SELECT
          balance::text AS balance,
          version::text AS version
        FROM wallets
        WHERE id = ?
        `,
        [command.walletId],
      );

      expect(wallets).toHaveLength(1);
      expect(wallets[0].balance).toBe('20.00');
      expect(wallets[0].version).toBe('2');

      const transactions = await em.execute<TransactionRow[]>(
        `
        SELECT status, original_response
        FROM wager_transactions
        WHERE id = ?
        `,
        [result.transactionId],
      );

      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe('PROCESSED');
      expect(transactions[0].original_response).toEqual(result);

      const ledger = await em.execute<LedgerRow[]>(
        `
        SELECT
          direction,
          amount::text AS amount,
          balance_before::text AS balance_before,
          balance_after::text AS balance_after
        FROM wallet_ledger_entries
        WHERE transaction_id = ?
        `,
        [result.transactionId],
      );

      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toEqual({
        direction: 'DEBIT',
        amount: '80.00',
        balance_before: '100.00',
        balance_after: '20.00',
      });
    });
  });

  it('não deve debitar duas vezes a mesma aposta', async () => {
    await withTestWallet(async (em, command) => {
      const service = new BettingService(em);

      const first = await service.placeBet(command);
      const second = await service.placeBet(command);

      // A segunda chamada precisa devolver a resposta original.
      expect(second).toEqual(first);

      const wallets = await em.execute<WalletRow[]>(
        `
        SELECT
          balance::text AS balance,
          version::text AS version
        FROM wallets
        WHERE id = ?
        `,
        [command.walletId],
      );

      expect(wallets[0].balance).toBe('20.00');
      expect(wallets[0].version).toBe('2');

      const ledger = await em.execute<Array<{ count: string }>>(
        `
        SELECT COUNT(*)::text AS count
        FROM wallet_ledger_entries
        WHERE transaction_id = ?
        `,
        [first.transactionId],
      );

      // Mesmo com duas chamadas, existe apenas um débito.
      expect(ledger[0].count).toBe('1');
    });
  });
});
