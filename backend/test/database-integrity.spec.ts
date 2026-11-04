
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

describe('Database - Financial integrity', () => {
  let app: INestApplication<App>;
  let em: EntityManager;

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'jungle_wagering_test') {
      throw new Error(
        'Estes testes exigem DB_NAME=jungle_wagering_test',
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

  async function createWallet() {
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

    return {
      playerId,
      walletId: response.body.id as string,
    };
  }

  async function insertReversalWithoutInternalReference(
    tx: EntityManager,
    walletId: string,
    playerId: string,
    kind: 'REFUND' | 'ROLLBACK',
    status: 'PROCESSED' | 'PENDING_REFERENCE',
  ) {
    await tx.execute(
      `
      INSERT INTO wager_transactions (
        id,
        wallet_id,
        player_id,
        provider_id,
        external_transaction_id,
        idempotency_key,
        payload_hash,
        round_id,
        game_id,
        kind,
        status,
        amount,
        currency,
        reference_external_transaction_id
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        1.00, 'BRL', ?
      )
      `,
      [
        randomUUID(),
        walletId,
        playerId,
        'schema-integrity-test',
        randomUUID(),
        randomUUID(),
        'a'.repeat(64),
        'round-schema-test',
        'game-schema-test',
        kind,
        status,
        randomUUID(),
      ],
    );
  }

  it('rejeita ledger associado à carteira errada', async () => {
    const walletA = await createWallet();
    const walletB = await createWallet();

    const transaction = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', randomUUID())
      .send({
        providerId: 'schema-integrity-test',
        externalTransactionId: randomUUID(),
        playerId: walletA.playerId,
        walletId: walletA.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: {
          amount: '10.00',
          currency: 'BRL',
        },
      })
      .expect(200);

    // A transação é da carteira A.
    // Tentamos criar um ledger atribuindo-a à carteira B.
    //
    // O teste usa uma transação SQL que será revertida
    // mesmo se a constraint estiver ausente.
    await expect(
      em.transactional(async (tx) => {
        await tx.execute(
          `
          INSERT INTO wallet_ledger_entries (
            id,
            wallet_id,
            transaction_id,
            direction,
            amount,
            currency,
            balance_before,
            balance_after
          )
          VALUES (
            ?, ?, ?, 'CREDIT',
            1.00, 'BRL', 0.00, 1.00
          )
          `,
          [
            randomUUID(),
            walletB.walletId,
            transaction.body.transactionId as string,
          ],
        );

        // Se chegar aqui, a FK não funcionou.
        // Lançar erro força rollback e impede
        // que o teste deixe um ledger inválido.
        throw new Error('INVALID_LEDGER_WAS_ACCEPTED');
      }),
    ).rejects.toThrow(
      'wallet_ledger_transaction_wallet_currency_fk',
    );
  });

  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    it(`rejeita ${kind} processado sem referência interna`, async () => {
      const wallet = await createWallet();

      await expect(
        em.transactional(async (tx) => {
          await insertReversalWithoutInternalReference(
            tx,
            wallet.walletId,
            wallet.playerId,
            kind,
            'PROCESSED',
          );

          // Nunca preservar uma operação inválida.
          throw new Error('INVALID_REVERSAL_WAS_ACCEPTED');
        }),
      ).rejects.toThrow(
        'wager_transactions_processed_reversal_reference_check',
      );
    });
  }

  it('permite referência interna nula para PENDING_REFERENCE', async () => {
    const wallet = await createWallet();

    // Este registro é permitido pelo schema:
    // a operação chegou antes da transação original.
    //
    // Fazemos rollback deliberado, pois este teste
    // verifica somente a constraint, não o fluxo completo.
    await expect(
      em.transactional(async (tx) => {
        await insertReversalWithoutInternalReference(
          tx,
          wallet.walletId,
          wallet.playerId,
          'REFUND',
          'PENDING_REFERENCE',
        );

        throw new Error('ROLLBACK_AFTER_VALID_PENDING');
      }),
    ).rejects.toThrow('ROLLBACK_AFTER_VALID_PENDING');
  });
});
