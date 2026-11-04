
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Post,
} from '@nestjs/common';
import {
  WalletAlreadyExistsError,
  WalletsService,
  type OpenWalletCommand,
  type OpenWalletResult,
} from '../application/services/wallets.service.js';
import { Money } from '../domain/value-objects/money.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  async open(@Body() body: unknown): Promise<OpenWalletResult> {
    // TypeScript não valida JSON recebido em runtime.
    // Por isso, começamos tratando o corpo como unknown.
    if (!isRecord(body)) {
      throw new BadRequestException({
        code: 'INVALID_PAYLOAD',
        message: 'O corpo da requisição deve ser um objeto JSON',
      });
    }

    if (
      typeof body.playerId !== 'string' ||
      !UUID_PATTERN.test(body.playerId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_PLAYER_ID',
        message: 'playerId deve ser um UUID válido',
      });
    }

    if (!isRecord(body.initialBalance)) {
      throw new BadRequestException({
        code: 'INVALID_INITIAL_BALANCE',
        message: 'initialBalance deve ser um objeto',
      });
    }

    const { amount, currency } = body.initialBalance;

    if (
      typeof amount !== 'string' ||
      typeof currency !== 'string'
    ) {
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message: 'amount e currency devem ser strings',
      });
    }

    // Valida o formato monetário antes de chamar
    // o serviço de aplicação.
    try {
      Money.from({ amount, currency });
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_MONEY',
        message:
          error instanceof Error
            ? error.message
            : 'Valor monetário inválido',
      });
    }

    const command: OpenWalletCommand = {
      playerId: body.playerId,
      initialBalance: {
        amount,
        currency,
      },
    };

    try {
      return await this.walletsService.open(command);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }

      // Falhas inesperadas de infraestrutura
      // continuam sendo tratadas pelo NestJS.
      throw error;
    }
  }
}
