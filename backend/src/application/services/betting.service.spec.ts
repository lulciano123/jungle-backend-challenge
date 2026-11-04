import { describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/postgresql';
import { BettingService, type PlaceBetCommand } from './betting.service.js';

describe('BettingService - Contrato obrigatório', () => {
  const validCommand: PlaceBetCommand = {
    walletId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    playerId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    providerId: 'contract-test-provider',
    externalTransactionId: 'transaction-contract-test',
    idempotencyKey: 'key-contract-test',
    roundId: 'round-contract-test',
    gameId: 'game-contract-test',
    amount: '10.00',
    currency: 'BRL',
  };

  const invalidValues: Array<[string, unknown]> = [
    ['ausente', undefined],
    ['nulo', null],
    ['vazio', ''],
    ['somente espaços', '   '],
    ['com tipo inválido', 123],
  ];

  for (const field of ['roundId', 'gameId'] as const) {
    for (const [description, value] of invalidValues) {
      it(`deve rejeitar ${field} ${description} antes de acessar o banco`, async () => {
        const transactional = vi.fn();
        const execute = vi.fn();
        const em = { transactional, execute } as unknown as EntityManager;
        const service = new BettingService(em);
        const command = { ...validCommand };

        // Simula dados de runtime que não respeitam o contrato TypeScript.
        if (value === undefined) {
          Reflect.deleteProperty(command, field);
        } else {
          Reflect.set(command, field, value);
        }

        await expect(service.placeBet(command)).rejects.toThrow(
          'Identificador da rodada ou jogo inválido',
        );

        expect(transactional).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      });
    }
  }
});
