
import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/core';

@Controller('health')
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  // Liveness: verifica se a aplicação responde.
  // Não depende do banco de dados.
  @Get('live')
  checkLiveness() {
    return {
      status: 'ok',
    };
  }

  // Readiness: verifica se o PostgreSQL
  // está disponível para operações.
  @Get('ready')
  async checkReadiness() {
    try {
      const rows = await this.orm.em
        .getConnection()
        .execute<{ ok: number }[]>('SELECT 1 AS ok');

      if (rows[0]?.ok !== 1) {
        throw new Error('Database check failed');
      }

      return {
        status: 'ok',
        database: 'up',
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
      });
    }
  }
}
