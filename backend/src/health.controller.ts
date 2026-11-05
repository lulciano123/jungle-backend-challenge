
import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/core';
import { createSqsClient, resolveQueues } from './infrastructure/sqs/sqs-config.js';

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

  // Readiness includes the broker without coupling HTTP commits to SQS availability.
  @Get('ready')
  async checkReadiness() {
    let database: 'up' | 'down' = 'down';
    try {
      const rows = await this.orm.em
        .getConnection()
        .execute<{ ok: number }[]>('SELECT 1 AS ok');

      if (rows[0]?.ok !== 1) {
        throw new Error('Database check failed');
      }
      database = 'up';
      const client = createSqsClient();
      try { await resolveQueues(client); } finally { client.destroy(); }

      return {
        status: 'ok',
        database: 'up',
        sqs: 'up',
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database,
        sqs: database === 'up' ? 'down' : 'unknown',
      });
    }
  }
}
