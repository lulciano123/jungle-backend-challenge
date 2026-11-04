
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

  roundId: string;
  gameId: string;
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
  idempotency_key: string;
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

  // Método mantido para compatibilidade com
  // os testes de integração anteriores.
  async placeBet(command: PlaceBetCommand): Promise<PlaceBetResult> {
    const execution = await this.placeBetWithMetadata(command);
    return execution.result;
  }

  async placeBetWithMetadata(
    command: PlaceBetCommand,
  ): Promise<PlaceBetExecution> {
    this.validateCommand(command);

    const playerId = command.playerId.toLowerCase();
    const walletId = command.walletId.toLowerCase();

    const amount = Money.from({
      amount: command.amount,
      currency: command.currency,
    });

    if (!amount.isPositive()) {
      throw new Error('A aposta deve ter valor positivo');
    }

    const normalizedAmount = amount.toJSON().amount;

    // Representação determinística dos dados financeiros.
    // A chave de idempotência não faz parte do hash.
    const canonicalPayload = {
      amount: normalizedAmount,
      currency: command.currency,
      externalTransactionId: command.externalTransactionId,
      gameId: command.gameId,
      kind: 'BET',
      playerId,
      providerId: command.providerId,
      roundId: command.roundId,
      walletId,
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    try {
      return await this.em.transactional(async (tx) => {
        // 1. Bloqueia a carteira afetada.
        // Isso serializa movimentações concorrentes
        // sobre a mesma linha no PostgreSQL.
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
          [walletId],
        );

        const wallet = wallets[0];

        if (!wallet) {
          throw new Error('Carteira não encontrada');
        }

        if (wallet.player_id !== playerId) {
          throw new Error('Carteira não pertence ao jogador');
        }

        if (wallet.currency !== command.currency) {
          throw new Error('Moeda incompatível com a carteira');
        }

        // 2. Busca uma transação já registrada pela
        // chave de idempotência OU pela referência externa.
        //
        // IMPORTANTE: recuperamos também a chave persistida
        // para impedir aliases não registrados.
        const previous = await tx.execute<ExistingTransactionRow[]>(
          `
          SELECT
            idempotency_key,
            payload_hash,
            original_response
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
          // Política de idempotência:
          // só é replay quando a chave E o payload
          // são iguais aos da operação original.
          //
          // Uma referência externa não pode ser usada
          // para registrar uma segunda chave implicitamente.
          if (
            previous.length !== 1 ||
            previous[0].idempotency_key !== command.idempotencyKey ||
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

          // Replay legítimo:
          // não debita novamente e não gera ledger.
          return {
            result: originalResponse,
            idempotentReplay: true,
          };
        }

        // 3. Calcula a decisão financeira.
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

        // 4. Persiste a decisão e a resposta original.
        // A rejeição por saldo insuficiente também
        // precisa ser registrada para a idempotência.
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
            walletId,
            playerId,
            command.providerId,
            command.externalTransactionId,
            command.idempotencyKey,
            payloadHash,
            command.roundId,
            command.gameId,
            result.status,
            normalizedAmount,
            command.currency,
            result.failureCode,
            result.balance,
            JSON.stringify(result),
          ],
        );

        // Rejeições financeiras não alteram saldo
        // e não geram lançamentos no ledger.
        if (!approved) {
          return {
            result,
            idempotentReplay: false,
          };
        }

        // 5. Atualiza saldo e versão.
        // O UPDATE mantém uma verificação de saldo
        // no próprio PostgreSQL.
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
            walletId,
            normalizedAmount,
          ],
        );

        if (
          updated.length !== 1 ||
          updated[0].balance !== result.balance
        ) {
          throw new Error('Falha de consistência do saldo');
        }

        // 6. Registra o débito no ledger imutável.
        // Se este INSERT falhar, a transação inteira
        // será revertida pelo PostgreSQL.
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
            walletId,
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
      // Executado depois do rollback transacional.
      if (isIdempotencyUniqueViolation(error)) {
        throw new IdempotencyConflictError();
      }

      // Erros de infraestrutura não são mascarados.
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

    for (const value of [command.roundId, command.gameId]) {
      if (
        typeof value !== 'string' || value.trim().length === 0
      ) {
        throw new Error(
          'Identificador da rodada ou jogo inválido',
        );
      }
    }
  }
}
