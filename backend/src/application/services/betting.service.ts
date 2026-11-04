
import { createHash, randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/value-objects/money.js';

export interface PlaceBetCommand {
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;

  // Obrigatórios na futura API HTTP.
  // Temporariamente opcionais para preservar os testes antigos.
  roundId?: string;
  gameId?: string;
}

export interface PlaceBetResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: string;
  currency: string;
  failureCode: string | null;
}

export interface PlaceBetExecution {
  result: PlaceBetResult;
  idempotentReplay: boolean;
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
}

interface ExistingTransactionRow {
  payload_hash: string;
  original_response: PlaceBetResult | null;
}

interface UpdatedWalletRow {
  balance: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDEMPOTENCY_CONSTRAINTS = new Set([
  'wager_transactions_idempotency_unique',
  'wager_transactions_provider_external_unique',
]);

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Conflito de idempotência');
    this.name = 'IdempotencyConflictError';
  }
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return false;
  }

  const databaseError = error as UniqueConstraintViolationException & {
    constraint?: unknown;
  };

  const cause = databaseError.cause;

  const causeConstraint =
    cause !== null &&
    typeof cause === 'object' &&
    'constraint' in cause
      ? cause.constraint
      : undefined;

  const constraintName =
    databaseError.constraint ?? causeConstraint;

  if (
    typeof constraintName === 'string' &&
    IDEMPOTENCY_CONSTRAINTS.has(constraintName)
  ) {
    return true;
  }

  return [...IDEMPOTENCY_CONSTRAINTS].some((name) =>
    error.message.includes(`constraint "${name}"`),
  );
}

@Injectable()
export class BettingService {
  constructor(private readonly em: EntityManager) {}

  // Compatibilidade com os testes financeiros existentes.
  async placeBet(command: PlaceBetCommand): Promise<PlaceBetResult> {
    const execution = await this.placeBetWithMetadata(command);
    return execution.result;
  }

  // A futura API HTTP utilizará este método para saber
  // se a resposta veio de uma execução nova ou de replay.
  async placeBetWithMetadata(
    command: PlaceBetCommand,
  ): Promise<PlaceBetExecution> {
    this.validateCommand(command);

    const amount = Money.from({
      amount: command.amount,
      currency: command.currency,
    });

    if (!amount.isPositive()) {
      throw new Error('A aposta deve ter valor positivo');
    }

    const normalizedAmount = amount.toJSON().amount;

    // JSON canônico com chaves em ordem fixa.
    // Não inclui o header de idempotência.
    const canonicalPayload = {
      amount: normalizedAmount,
      currency: command.currency,
      externalTransactionId: command.externalTransactionId,
      gameId: command.gameId ?? null,
      kind: 'BET',
      playerId: command.playerId,
      providerId: command.providerId,
      roundId: command.roundId ?? null,
      walletId: command.walletId,
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    try {
      return await this.em.transactional(async (tx) => {
        // 1. Bloqueia exclusivamente a carteira afetada.
        const wallets = await tx.execute<WalletRow[]>(
          `
          SELECT
            id,
            player_id,
            currency,
            balance::text AS balance
          FROM wallets
          WHERE id = ?
          FOR UPDATE
          `,
          [command.walletId],
        );

        const wallet = wallets[0];

        if (!wallet) {
          throw new Error('Carteira não encontrada');
        }

        if (wallet.player_id !== command.playerId) {
          throw new Error('Carteira não pertence ao jogador');
        }

        if (wallet.currency !== command.currency) {
          throw new Error('Moeda incompatível com a carteira');
        }

        // 2. Consulta a idempotência persistente.
        const previous = await tx.execute<ExistingTransactionRow[]>(
          `
          SELECT payload_hash, original_response
          FROM wager_transactions
          WHERE idempotency_key = ?
             OR (
               provider_id = ?
               AND external_transaction_id = ?
             )
          FOR UPDATE
          `,
          [
            command.idempotencyKey,
            command.providerId,
            command.externalTransactionId,
          ],
        );

        if (previous.length > 0) {
          if (
            previous.length !== 1 ||
            previous[0].payload_hash !== payloadHash
          ) {
            throw new IdempotencyConflictError();
          }

          const originalResponse = previous[0].original_response;

          if (!originalResponse) {
            throw new Error('Transação anterior ainda não finalizada');
          }

          // Não modifica o saldo e não gera outro ledger.
          return {
            result: originalResponse,
            idempotentReplay: true,
          };
        }

        // 3. Avalia o saldo disponível.
        const balanceBefore = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });

        const approved = !balanceBefore.isLessThan(amount);

        const balanceAfter = approved
          ? balanceBefore.subtract(amount)
          : balanceBefore;

        const transactionId = randomUUID();

        const result: PlaceBetResult = {
          transactionId,
          status: approved ? 'PROCESSED' : 'REJECTED',
          balance: balanceAfter.toJSON().amount,
          currency: command.currency,
          failureCode: approved ? null : 'INSUFFICIENT_FUNDS',
        };

        // 4. Persiste a transação e a resposta original.
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
            failure_code,
            result_balance,
            original_response,
            processed_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'BET', ?, ?::numeric, ?, ?,
            ?::numeric, ?::jsonb, NOW()
          )
          `,
          [
            transactionId,
            command.walletId,
            command.playerId,
            command.providerId,
            command.externalTransactionId,
            command.idempotencyKey,
            payloadHash,
            command.roundId ?? null,
            command.gameId ?? null,
            result.status,
            normalizedAmount,
            command.currency,
            result.failureCode,
            result.balance,
            JSON.stringify(result),
          ],
        );

        // A rejeição por saldo insuficiente também é
        // persistida, mas não altera saldo nem ledger.
        if (!approved) {
          return {
            result,
            idempotentReplay: false,
          };
        }

        // 5. Atualiza saldo e versão atomicamente.
        const updated = await tx.execute<UpdatedWalletRow[]>(
          `
          UPDATE wallets
          SET
            balance = balance - ?::numeric,
            version = version + 1,
            updated_at = NOW()
          WHERE id = ?
            AND balance >= ?::numeric
          RETURNING balance::text AS balance
          `,
          [
            normalizedAmount,
            command.walletId,
            normalizedAmount,
          ],
        );

        if (
          updated.length !== 1 ||
          updated[0].balance !== result.balance
        ) {
          throw new Error('Falha de consistência do saldo');
        }

        // 6. Registra o lançamento imutável.
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
            ?, ?, ?, 'DEBIT',
            ?::numeric, ?, ?::numeric, ?::numeric
          )
          `,
          [
            randomUUID(),
            command.walletId,
            transactionId,
            normalizedAmount,
            command.currency,
            balanceBefore.toJSON().amount,
            result.balance,
          ],
        );

        return {
          result,
          idempotentReplay: false,
        };
      });
    } catch (error) {
      // Este tratamento ocorre após o rollback.
      if (isIdempotencyUniqueViolation(error)) {
        throw new IdempotencyConflictError();
      }

      throw error;
    }
  }

  private validateCommand(command: PlaceBetCommand): void {
    if (
      !command ||
      typeof command.walletId !== 'string' ||
      !UUID_PATTERN.test(command.walletId) ||
      typeof command.playerId !== 'string' ||
      !UUID_PATTERN.test(command.playerId)
    ) {
      throw new Error('Identificadores inválidos');
    }

    const requiredFields = [
      command.providerId,
      command.externalTransactionId,
      command.idempotencyKey,
    ];

    if (
      requiredFields.some(
        (value) =>
          typeof value !== 'string' ||
          value.trim().length === 0
      )
    ) {
      throw new Error('Identificadores da operação inválidos');
    }

    // Os campos são opcionais somente para compatibilidade
    // com os testes antigos. A API HTTP os exigirá.
    for (const value of [command.roundId, command.gameId]) {
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.trim().length === 0)
      ) {
        throw new Error('Identificador da rodada ou jogo inválido');
      }
    }
  }
}