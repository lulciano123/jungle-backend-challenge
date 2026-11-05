import { createHash, randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Wallet } from '../../domain/entities/wallet.js';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/integration-event.js';
import { writeEvents } from '../messaging/write-events.js';
import {
  Money,
  type MoneyProps,
} from '../../domain/value-objects/money.js';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor() {
    super('Carteira já existe para jogador e moeda');
    this.name = 'WalletAlreadyExistsError';
  }
}

function isWalletDuplicate(error: unknown): boolean {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return false;
  }

  const cause = error.cause;

  const constraint =
    cause !== null &&
    typeof cause === 'object' &&
    'constraint' in cause
      ? cause.constraint
      : undefined;

  return (
    constraint === 'wallets_player_currency_unique' ||
    error.message.includes(
      'constraint "wallets_player_currency_unique"',
    )
  );
}

@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  async open(command: OpenWalletCommand): Promise<OpenWalletResult> {
    if (
      !command ||
      typeof command.playerId !== 'string' ||
      !UUID_PATTERN.test(command.playerId)
    ) {
      throw new Error('Identificador do jogador inválido');
    }

    const playerId = command.playerId.toLowerCase();

    // Money impede floats, formatos inválidos,
    // moedas não suportadas e valores negativos.
    const initialBalance = Money.from(command.initialBalance);

    const walletId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
    });

    const money = initialBalance.toJSON();

    const result: OpenWalletResult = {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: money,
      version: wallet.version,
    };

    try {
      return await this.em.transactional(async (tx) => {
        // A carteira sempre começa na versão 1.
        await tx.execute(
          `
          INSERT INTO wallets (
            id,
            player_id,
            currency,
            balance,
            version
          )
          VALUES (?, ?, ?, ?::numeric, 1)
          `,
          [
            wallet.id,
            wallet.playerId,
            money.currency,
            money.amount,
          ],
        );

        // Uma carteira com saldo zero não precisa
        // de movimentação financeira de abertura.
        if (initialBalance.isZero()) {
          return result;
        }

        // Saldo positivo exige OPENING + CREDIT.
        const transactionId = randomUUID();
        const openingReference = `opening:${wallet.id}`;

        const payloadHash = createHash('sha256')
          .update(
            JSON.stringify({
              kind: 'OPENING',
              walletId: wallet.id,
              playerId: wallet.playerId,
              amount: money.amount,
              currency: money.currency,
            }),
          )
          .digest('hex');

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
            kind,
            status,
            amount,
            currency,
            result_balance,
            original_response,
            processed_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            'OPENING', 'PROCESSED',
            ?::numeric, ?, ?::numeric,
            ?::jsonb, NOW()
          )
          `,
          [
            transactionId,
            wallet.id,
            wallet.playerId,
            '__internal__',
            openingReference,
            openingReference,
            payloadHash,
            money.amount,
            money.currency,
            money.amount,
            JSON.stringify(result),
          ],
        );

        // O crédito inicial parte do saldo zero.
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
            ?::numeric, ?, 0.00, ?::numeric
          )
          `,
          [
            randomUUID(),
            wallet.id,
            transactionId,
            money.amount,
            money.currency,
            money.amount,
          ],
        );

        const context = { correlationId: openingReference };
        await writeEvents(tx, [
          WagerTransactionProcessed.from({
            transactionId, walletId: wallet.id, playerId: wallet.playerId,
            providerId: '__internal__', externalTransactionId: openingReference,
            roundId: null, gameId: null, kind: 'OPENING', money,
            balance: money, referenceExternalTransactionId: null,
          }, context),
          WalletBalanceChanged.from({
            walletId: wallet.id, transactionId, direction: 'CREDIT', money,
            balanceBefore: { amount: '0.00', currency: money.currency },
            balanceAfter: money, walletVersion: String(wallet.version),
          }, context),
        ]);

        // Se qualquer INSERT falhar, a criação
        // da carteira também será revertida.
        return result;
      });
    } catch (error) {
      if (isWalletDuplicate(error)) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }
}
