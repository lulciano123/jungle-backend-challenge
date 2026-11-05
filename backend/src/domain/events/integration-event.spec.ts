import { describe, expect, it } from 'vitest';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from './integration-event.js';

describe('Integration events', () => {
  it('copies and freezes nested financial DTOs and protects occurredAt', () => {
    const data = {
      walletId: 'wallet',
      transactionId: 'transaction',
      direction: 'CREDIT' as const,
      money: { amount: '0.01', currency: 'BRL' },
      balanceBefore: { amount: '999.99', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: '9007199254740993',
    };
    const event = WalletBalanceChanged.from(data, {
      correlationId: 'correlation',
      causationId: 'message',
    });
    const before = JSON.stringify(event.toJSON());
    data.money.amount = '100.00';
    expect(Reflect.set(event.data.money, 'amount', '123.00')).toBe(false);
    expect(Reflect.set(event, 'eventId', 'other')).toBe(false);
    event.occurredAt.setUTCFullYear(1900);
    expect(JSON.stringify(event.toJSON())).toBe(before);
    expect(event.toJSON().data.walletVersion).toBe('9007199254740993');
  });

  it('keeps event identity stable through repeated serialization with decimal strings', () => {
    const event = WagerTransactionProcessed.from(
      {
        transactionId: 'tx',
        walletId: 'wallet',
        playerId: 'player',
        providerId: 'provider',
        externalTransactionId: 'external',
        roundId: 'round',
        gameId: 'game',
        kind: 'LOSS',
        money: { amount: '0.01', currency: 'BRL' },
        balance: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: null,
      },
      { correlationId: 'correlation' },
    );
    expect(event.toJSON()).toEqual(event.toJSON());
    expect(event.toJSON().version).toBe(1);
    expect(event.toJSON().eventType).toBe('WagerTransactionProcessed');
    expect(event.toJSON().data.money.amount).toBe('0.01');
    expect(event.toJSON()).not.toHaveProperty('causationId');
  });
});
