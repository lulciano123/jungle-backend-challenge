import type { SubmitWagerCommand } from '../services/betting.service.js';
import { Money } from '../../domain/value-objects/money.js';

export class InvalidWagerPayloadError extends Error {
  readonly code: string;
  constructor(details: { code: string; message: string }) {
    super(details.message);
    this.name = 'InvalidWagerPayloadError';
    this.code = details.code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function parseWagerCommand(
  body: unknown,
  idempotencyKey: unknown,
): SubmitWagerCommand {
  // O header é a fonte da verdade para a idempotência.
  if (!isNonEmptyString(idempotencyKey)) {
    throw new InvalidWagerPayloadError({
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Header Idempotency-Key obrigatório',
    });
  }

  // Não confiar em tipos TypeScript para validar JSON externo.
  if (!isRecord(body)) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_PAYLOAD',
      message: 'O corpo deve ser um objeto JSON',
    });
  }

  if (
    body.kind !== 'BET' &&
    body.kind !== 'WIN' &&
    body.kind !== 'LOSS' &&
    body.kind !== 'REFUND' &&
    body.kind !== 'ROLLBACK'
  ) {
    throw new InvalidWagerPayloadError({
      code: 'UNSUPPORTED_TRANSACTION_KIND',
      message: 'Tipos disponíveis: BET, WIN, LOSS, REFUND e ROLLBACK',
    });
  }

  const requiresReference = body.kind === 'REFUND' || body.kind === 'ROLLBACK';
  const acceptsReference = body.kind === 'WIN' || requiresReference;
  if (requiresReference && body.referenceExternalTransactionId === undefined) {
    throw new InvalidWagerPayloadError({
      code: 'MISSING_REFERENCE',
      message: 'referenceExternalTransactionId é obrigatório para reversões',
    });
  }

  if (
    acceptsReference &&
    body.referenceExternalTransactionId !== undefined &&
    !isNonEmptyString(body.referenceExternalTransactionId)
  ) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_REFERENCE',
      message: 'referenceExternalTransactionId deve ser uma string não vazia',
    });
  }

  if (!isUUID(body.playerId) || !isUUID(body.walletId)) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_IDENTIFIERS',
      message: 'playerId e walletId devem ser UUIDs válidos',
    });
  }

  if (
    !isNonEmptyString(body.providerId) ||
    !isNonEmptyString(body.externalTransactionId) ||
    !isNonEmptyString(body.roundId) ||
    !isNonEmptyString(body.gameId)
  ) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_TRANSACTION_FIELDS',
      message: 'Campos de identificação da operação inválidos',
    });
  }

  if (!isRecord(body.money)) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_MONEY',
      message: 'money deve ser um objeto',
    });
  }

  const { amount, currency } = body.money;

  if (typeof amount !== 'string' || typeof currency !== 'string') {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_MONEY',
      message: 'amount e currency devem ser strings',
    });
  }

  try {
    const money = Money.from({ amount, currency });

    if (!money.isPositive()) {
      throw new Error('O valor da operação deve ser positivo');
    }
  } catch (error) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_MONEY',
      message:
        error instanceof Error ? error.message : 'Valor monetário inválido',
    });
  }

  const command: SubmitWagerCommand = {
    kind: body.kind,
    playerId: body.playerId,
    walletId: body.walletId,
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    roundId: body.roundId,
    gameId: body.gameId,
    idempotencyKey,
    amount,
    currency,
    ...(acceptsReference && body.referenceExternalTransactionId !== undefined
      ? {
          referenceExternalTransactionId:
            body.referenceExternalTransactionId as string,
        }
      : {}),
  };

  return command;
}
