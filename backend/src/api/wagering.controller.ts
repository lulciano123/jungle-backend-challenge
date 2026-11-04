
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  BettingService,
  IdempotencyConflictError,
  type SubmitWagerCommand,
} from '../application/services/betting.service.js';
import { Money } from '../domain/value-objects/money.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0
  );
}

function isUUID(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UUID_PATTERN.test(value)
  );
}

export interface WageringHttpResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  balance: {
    amount: string;
    currency: string;
  };
  idempotentReplay: boolean;
  failureCode: string | null;
}

@Controller('wagering')
export class WageringController {
  constructor(private readonly bettingService: BettingService) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) httpResponse: Response,
  ): Promise<WageringHttpResult> {
    // O header é a fonte da verdade para a idempotência.
    if (!isNonEmptyString(idempotencyKey)) {
      throw new BadRequestException({
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Header Idempotency-Key obrigatório',
      });
    }

    // Não confiar em tipos TypeScript para validar JSON externo.
    if (!isRecord(body)) {
      throw new BadRequestException({
        code: 'INVALID_PAYLOAD',
        message: 'O corpo deve ser um objeto JSON',
      });
    }

    if (
      body.kind !== 'BET' && body.kind !== 'WIN' && body.kind !== 'LOSS' &&
      body.kind !== 'REFUND' && body.kind !== 'ROLLBACK'
    ) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_TRANSACTION_KIND',
        message: 'Tipos disponíveis: BET, WIN, LOSS, REFUND e ROLLBACK',
      });
    }

    const requiresReference = body.kind === 'REFUND' || body.kind === 'ROLLBACK';
    const acceptsReference = body.kind === 'WIN' || requiresReference;
    if (requiresReference && body.referenceExternalTransactionId === undefined) {
      throw new BadRequestException({
        code: 'MISSING_REFERENCE',
        message: 'referenceExternalTransactionId é obrigatório para reversões',
      });
    }

    if (
      acceptsReference &&
      body.referenceExternalTransactionId !== undefined &&
      !isNonEmptyString(body.referenceExternalTransactionId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_REFERENCE',
        message: 'referenceExternalTransactionId deve ser uma string não vazia',
      });
    }

    if (
      !isUUID(body.playerId) ||
      !isUUID(body.walletId)
    ) {
      throw new BadRequestException({
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
      throw new BadRequestException({
        code: 'INVALID_TRANSACTION_FIELDS',
        message: 'Campos de identificação da operação inválidos',
      });
    }

    if (!isRecord(body.money)) {
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message: 'money deve ser um objeto',
      });
    }

    const { amount, currency } = body.money;

    if (
      typeof amount !== 'string' ||
      typeof currency !== 'string'
    ) {
      throw new BadRequestException({
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
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message:
          error instanceof Error
            ? error.message
            : 'Valor monetário inválido',
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
        ? { referenceExternalTransactionId: body.referenceExternalTransactionId as string }
        : {}),
    };

    try {
      const execution =
        await this.bettingService.submitTransaction(command);

      const { result, idempotentReplay } = execution;

      const response: WageringHttpResult = {
        transactionId: result.transactionId,
        status: result.status,
        balance: {
          amount: result.balance,
          currency: result.currency,
        },
        idempotentReplay,
        failureCode: result.failureCode,
      };

      // Rejeição financeira é diferente de erro de infraestrutura.
      // A decisão permanece registrada para idempotência.
      if (result.status === 'REJECTED') {
        throw new UnprocessableEntityException({
          code: result.failureCode ?? 'BUSINESS_RULE_REJECTED',
          ...response,
        });
      }

      if (result.status === 'PENDING_REFERENCE') {
        httpResponse.status(HttpStatus.ACCEPTED);
      }

      return response;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }

      if (error instanceof UnprocessableEntityException) {
        throw error;
      }

      if (
        error instanceof Error &&
        error.message === 'Carteira não encontrada'
      ) {
        throw new NotFoundException({
          code: 'WALLET_NOT_FOUND',
          message: error.message,
        });
      }

      if (
        error instanceof Error &&
        (
          error.message === 'Carteira não pertence ao jogador' ||
          error.message === 'Moeda incompatível com a carteira'
        )
      ) {
        throw new ConflictException({
          code: 'WALLET_MISMATCH',
          message: error.message,
        });
      }

      // Erros SQL e falhas inesperadas não são mascarados.
      throw error;
    }
  }
}
