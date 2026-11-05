
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
import { parseWagerCommand, InvalidWagerPayloadError } from '../application/messaging/parse-wager-command.js';

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
    let command: SubmitWagerCommand;
    try {
      command = parseWagerCommand(body, idempotencyKey);
    } catch (error) {
      if (error instanceof InvalidWagerPayloadError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }

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
