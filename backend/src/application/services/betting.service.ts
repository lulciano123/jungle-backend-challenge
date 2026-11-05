
import { createHash, randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/value-objects/money.js';
import {
  WagerTransactionProcessed, WagerTransactionRejected,
  WagerTransactionPendingReference, WalletBalanceChanged,
  type EventContext, type WagerTransactionData,
} from '../../domain/events/integration-event.js';
import { writeEvents } from '../messaging/write-events.js';

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

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface SubmitWagerCommand extends PlaceBetCommand {
  kind: WagerKind;
  referenceExternalTransactionId?: string;
}

export interface PlaceBetResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
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
  version: string;
}

interface ReferenceTransactionRow {
  id: string;
  player_id: string;
  wallet_id: string;
  currency: string;
  round_id: string | null;
  kind: string;
  status: string;
  amount: string;
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
    return this.submitTransaction({ ...command, kind: 'BET' });
  }

  async submitTransaction(command: SubmitWagerCommand): Promise<PlaceBetExecution> {
    return this.execute(command);
  }

  // The Inbox owns the commit. This method never starts a nested transaction.
  async submitTransactionInTransaction(
    tx: EntityManager,
    command: SubmitWagerCommand,
    context: EventContext,
  ): Promise<PlaceBetExecution> {
    if (!tx.isInTransaction()) throw new Error('Financial processing requires an active SQL transaction');
    return this.execute(command, tx, context);
  }

  private async execute(
    command: SubmitWagerCommand,
    transaction?: EntityManager,
    context?: EventContext,
  ): Promise<PlaceBetExecution> {
    this.validateCommand(command);

    const playerId = command.playerId.toLowerCase();
    const walletId = command.walletId.toLowerCase();

    const amount = Money.from({
      amount: command.amount,
      currency: command.currency,
    });

    if (!amount.isPositive()) {
      throw new Error('A operação deve ter valor positivo');
    }

    const normalizedAmount = amount.toJSON().amount;
    const isReversal = command.kind === 'REFUND' || command.kind === 'ROLLBACK';
    const referenceExternalTransactionId = command.kind === 'WIN' || isReversal
      ? command.referenceExternalTransactionId
      : undefined;

    // Representação determinística dos dados financeiros.
    // A chave de idempotência não faz parte do hash.
    const canonicalPayload = {
      amount: normalizedAmount,
      currency: command.currency,
      externalTransactionId: command.externalTransactionId,
      gameId: command.gameId,
      kind: command.kind,
      playerId,
      providerId: command.providerId,
      // Ausência de referência preserva o hash das apostas já existentes.
      ...(referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId }
        : {}),
      roundId: command.roundId,
      walletId,
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    try {
      const operation = async (tx: EntityManager): Promise<PlaceBetExecution> => {
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

          // Replay não reaplica efeitos financeiros nem gera ledger.
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

        let status: PlaceBetResult['status'] = 'PROCESSED';
        let failureCode: string | null = null;
        let referenceTransactionId: string | null = null;
        let balanceAfter = balanceBefore;
        let direction: 'DEBIT' | 'CREDIT' | null = command.kind === 'BET'
          ? 'DEBIT'
          : command.kind === 'WIN' || command.kind === 'REFUND' ? 'CREDIT' : null;

        if (referenceExternalTransactionId !== undefined) {
          const references = await tx.execute<ReferenceTransactionRow[]>(
            `
            SELECT id, player_id, wallet_id, currency, round_id, kind, status,
              amount::text AS amount
            FROM wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
            `,
            [command.providerId, referenceExternalTransactionId],
          );
          const reference = references[0];

          if (!reference) {
            status = 'PENDING_REFERENCE';
          } else {
            referenceTransactionId = reference.id;
            const allowedReferenceKinds = command.kind === 'ROLLBACK'
              ? ['BET', 'WIN', 'REFUND']
              : ['BET'];

            if (!allowedReferenceKinds.includes(reference.kind)) {
              status = 'REJECTED';
              failureCode = 'INVALID_REFERENCE_KIND';
            } else if (
              reference.player_id !== playerId ||
              reference.wallet_id !== walletId ||
              reference.currency !== command.currency ||
              reference.round_id !== command.roundId
            ) {
              status = 'REJECTED';
              failureCode = 'REFERENCE_MISMATCH';
            } else if (isReversal && reference.status !== 'PROCESSED') {
              status = 'REJECTED';
              failureCode = 'REFERENCE_NOT_PROCESSED';
            } else if (isReversal && !amount.equals(Money.from({
              amount: reference.amount,
              currency: reference.currency,
            }))) {
              status = 'REJECTED';
              failureCode = 'REFERENCE_AMOUNT_MISMATCH';
            } else if (isReversal) {
              // A wallet permanece bloqueada durante a decisão e a gravação.
              // O índice único limita a uma reversão PROCESSED por referência e tipo.
              const reversals = await tx.execute<Array<{ id: string }>>(`
                SELECT id FROM wager_transactions
                WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED'
                LIMIT 1
              `, [reference.id, command.kind]);

              if (reversals.length > 0) {
                status = 'REJECTED';
                failureCode = 'REFERENCE_ALREADY_REVERSED';
              } else if (command.kind === 'ROLLBACK') {
                direction = reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
              }
            }
          }
        }

        if (status === 'PROCESSED' && direction === 'DEBIT') {
          if (balanceBefore.isLessThan(amount)) {
            status = 'REJECTED';
            failureCode = isReversal ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS';
          } else {
            balanceAfter = balanceBefore.subtract(amount);
          }
        } else if (status === 'PROCESSED' && direction === 'CREDIT') {
          try {
            balanceAfter = balanceBefore.add(amount);
          } catch (error) {
            if (!(error instanceof RangeError)) {
              throw error;
            }

            status = 'REJECTED';
            failureCode = 'BALANCE_LIMIT_EXCEEDED';
          }
        }

        const transactionId = randomUUID();

        const result: PlaceBetResult = {
          transactionId,
          status,
          balance: balanceAfter.toJSON().amount,
          currency: command.currency,
          failureCode,
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
            reference_external_transaction_id,
            reference_transaction_id,
            failure_code,
            result_balance,
            original_response,
            processed_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?::numeric, ?, ?, ?, ?,
            ?::numeric, ?::jsonb,
            CASE WHEN ? = 'PENDING_REFERENCE' THEN NULL ELSE NOW() END
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
            command.kind,
            result.status,
            normalizedAmount,
            command.currency,
            referenceExternalTransactionId ?? null,
            referenceTransactionId,
            result.failureCode,
            result.balance,
            JSON.stringify(result),
            result.status,
          ],
        );

        const eventContext = context ?? { correlationId: command.idempotencyKey };
        const eventData: WagerTransactionData = {
          transactionId, walletId, playerId,
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          roundId: command.roundId, gameId: command.gameId, kind: command.kind,
          money: amount.toJSON(),
          balance: { amount: result.balance, currency: result.currency },
          referenceExternalTransactionId: referenceExternalTransactionId ?? null,
        };
        const transactionEvent = status === 'PROCESSED'
          ? WagerTransactionProcessed.from(eventData, eventContext)
          : status === 'PENDING_REFERENCE'
            ? WagerTransactionPendingReference.from(eventData, eventContext)
            : WagerTransactionRejected.from({ ...eventData, failureCode: failureCode! }, eventContext);

        // LOSS, rejeições e referências pendentes não alteram saldo ou versão.
        if (status !== 'PROCESSED' || direction === null) {
          await writeEvents(tx, [transactionEvent]);
          return {
            result,
            idempotentReplay: false,
          };
        }

        const balanceDelta = direction === 'DEBIT'
          ? amount.negate().toJSON().amount
          : normalizedAmount;

        // 5. Atualiza saldo e versão sob o mesmo lock por wallet.
        // O UPDATE mantém uma verificação de saldo
        // no próprio PostgreSQL.
        const updated = await tx.execute<UpdatedWalletRow[]>(
          `
          UPDATE wallets
          SET
            balance = balance + ?::numeric,
            version = version + 1,
            updated_at = NOW()
          WHERE id = ?
            AND balance + ?::numeric >= 0
          RETURNING balance::text AS balance, version::text AS version
          `,
          [
            balanceDelta,
            walletId,
            balanceDelta,
          ],
        );

        if (
          updated.length !== 1 ||
          updated[0].balance !== result.balance
        ) {
          throw new Error('Falha de consistência do saldo');
        }

        // 6. Registra o lançamento correspondente no ledger imutável.
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
            ?, ?, ?, ?,
            ?::numeric, ?, ?::numeric, ?::numeric
          )
          `,
          [
            randomUUID(),
            walletId,
            transactionId,
            direction,
            normalizedAmount,
            command.currency,
            balanceBefore.toJSON().amount,
            result.balance,
          ],
        );

        await writeEvents(tx, [
          transactionEvent,
          WalletBalanceChanged.from({
            walletId, transactionId, direction, money: amount.toJSON(),
            balanceBefore: balanceBefore.toJSON(),
            balanceAfter: { amount: result.balance, currency: result.currency },
            walletVersion: updated[0].version,
          }, eventContext),
        ]);

        return {
          result,
          idempotentReplay: false,
        };
      };
      return await (transaction ? operation(transaction) : this.em.transactional(operation));
    } catch (error) {
      // The transaction owner rolls back before handling this error.
      if (isIdempotencyUniqueViolation(error)) {
        throw new IdempotencyConflictError();
      }

      // Erros de infraestrutura não são mascarados.
      throw error;
    }
  }

  private validateCommand(command: SubmitWagerCommand): void {
    if (
      !command ||
      typeof command.walletId !== 'string' ||
      !UUID_PATTERN.test(command.walletId) ||
      typeof command.playerId !== 'string' ||
      !UUID_PATTERN.test(command.playerId)
    ) {
      throw new Error('Identificadores inválidos');
    }

    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(command.kind)) {
      throw new Error('Tipo de operação não suportado');
    }

    const isReversal = command.kind === 'REFUND' || command.kind === 'ROLLBACK';
    if (isReversal && command.referenceExternalTransactionId === undefined) {
      throw new Error('Referência externa obrigatória');
    }

    if (
      (command.kind === 'WIN' || isReversal) &&
      command.referenceExternalTransactionId !== undefined &&
      (
        typeof command.referenceExternalTransactionId !== 'string' ||
        command.referenceExternalTransactionId.trim().length === 0
      )
    ) {
      throw new Error('Referência externa inválida');
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
