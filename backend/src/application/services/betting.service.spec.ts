import { describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  BettingService,
  type PlaceBetCommand,
  type SubmitWagerCommand,
} from './betting.service.js';

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

  for (const kind of ['OPENING', 'UNKNOWN']) {
    it(`rejeita ${kind} antes de iniciar uma transação`, async () => {
      const transactional = vi.fn();
      const service = new BettingService({ transactional } as unknown as EntityManager);
      const command = { ...validCommand, kind } as SubmitWagerCommand;
      await expect(service.submitTransaction(command)).rejects.toThrow('Tipo de operação não suportado');
      expect(transactional).not.toHaveBeenCalled();
    });
  }

  for (const referenceExternalTransactionId of [null, '', '   ']) {
    it(`rejeita referência WIN inválida antes de iniciar uma transação: ${JSON.stringify(referenceExternalTransactionId)}`, async () => {
      const transactional = vi.fn();
      const service = new BettingService({ transactional } as unknown as EntityManager);
      const command = {
        ...validCommand, kind: 'WIN', referenceExternalTransactionId,
      } as SubmitWagerCommand;
      await expect(service.submitTransaction(command)).rejects.toThrow('Referência externa inválida');
      expect(transactional).not.toHaveBeenCalled();
    });
  }

  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    for (const reference of [undefined, null, '', '   ']) {
      it(`rejeita ${kind} sem referência válida antes de acessar o banco: ${JSON.stringify(reference)}`, async () => {
        const transactional = vi.fn();
        const service = new BettingService({ transactional } as unknown as EntityManager);
        const command = {
          ...validCommand, kind, referenceExternalTransactionId: reference,
        } as SubmitWagerCommand;
        await expect(service.submitTransaction(command)).rejects.toThrow(
          reference === undefined ? 'Referência externa obrigatória' : 'Referência externa inválida',
        );
        expect(transactional).not.toHaveBeenCalled();
      });
    }
  }
});
