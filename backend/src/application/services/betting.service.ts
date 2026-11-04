
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
}

export interface PlaceBetResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: string;
  currency: string;
  failureCode: string | null;
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

// Erro de domínio estável, independente do PostgreSQL.
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Conflito de idempotência');
    this.name = 'IdempotencyConflictError';
  }
}

// Identifica exclusivamente violações das duas
// restrições de unicidade relacionadas à idempotência.
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

  // Compatibilidade caso o driver exponha somente
  // a mensagem, sem a propriedade constraint.
  return [...IDEMPOTENCY_CONSTRAINTS].some((name) =>
    error.message.includes(`constraint "${name}"`),
  );
}

@Injectable()
export class BettingService {
  constructor(private readonly em: EntityManager) {}

  async placeBet(command: PlaceBetCommand): Promise<PlaceBetResult> {
    this.validateCommand(command);

    const amount = Money.from({
      amount: command.amount,
      currency: command.currency,
    });

    if (!amount.isPositive()) {
      throw new Error('A aposta deve ter valor positivo');
    }

    // Hash determinístico dos dados da operação.
    // A chave de idempotência não faz parte do hash.
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          walletId: command.walletId,
          playerId: command.playerId,
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          amount: amount.toJSON().amount,
          currency: command.currency,
        }),
      )
      .digest('hex');

    try {
      // O try/catch fica FORA da transação.
      // Assim, qualquer erro SQL provoca rollback
      // antes de ser convertido em erro de domínio.
      return await this.em.transactional(async (tx) => {
        // 1. Bloqueia a carteira durante a transação.
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

        // 2. Verifica transações anteriores.
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
            throw new Error(
              'Transação anterior ainda não finalizada',
            );
          }

          // Replay: retorna a resposta original
          // sem alterar saldo nem criar ledger.
          return originalResponse;
        }

        const balanceBefore = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });

        // 3. Calcula o resultado da aposta.
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

        // 4. Registra a decisão e a resposta original.
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
            failure_code,
            result_balance,
            original_response,
            processed_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?,
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
            result.status,
            amount.toJSON().amount,
            command.currency,
            result.failureCode,
            result.balance,
            JSON.stringify(result),
          ],
        );

        // Rejeição por saldo insuficiente:
        // persiste a decisão, mas não gera débito.
        if (!approved) {
          return result;
        }

        // 5. Atualiza saldo sob o mesmo bloqueio SQL.
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
            amount.toJSON().amount,
            command.walletId,
            amount.toJSON().amount,
          ],
        );

        if (
          updated.length !== 1 ||
          updated[0].balance !== result.balance
        ) {
          throw new Error('Falha de consistência do saldo');
        }

        // 6. Insere o lançamento financeiro imutável.
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
            amount.toJSON().amount,
            command.currency,
            balanceBefore.toJSON().amount,
            result.balance,
          ],
        );

        // O MikroORM confirma a transação
        // somente após a conclusão do callback.
        return result;
      });
    } catch (error) {
      // O rollback já ocorreu quando chegamos aqui.
      if (isIdempotencyUniqueViolation(error)) {
        throw new IdempotencyConflictError();
      }

      // Não mascara erros de conexão, SQL, FK,
      // constraints monetárias ou outras falhas.
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
          value.trim().length === 0,
      )
    ) {
      throw new Error('Identificadores da operação inválidos');
    }
  }
}
