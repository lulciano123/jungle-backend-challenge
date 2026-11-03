
import { describe, expect, it } from 'vitest';
import { Money } from '../value-objects/money.js';
import {
  WalletLedgerEntry,
  LedgerDirection,
} from './wallet-ledger-entry.js';

describe('WalletLedgerEntry', () => {
  const brl = (amount: string) =>
    Money.from({ amount, currency: 'BRL' });

  const createEntry = (
    direction: LedgerDirection,
    before: string,
    movement: string,
    after: string,
  ) =>
    WalletLedgerEntry.create({
      id: 'ledger-001',
      walletId: 'wallet-001',
      transactionId: 'transaction-001',
      direction,
      money: brl(movement),
      balanceBefore: brl(before),
      balanceAfter: brl(after),
      createdAt: new Date('2026-11-03T12:00:00Z'),
    });

  it('deve validar um débito correto', () => {
    const entry = createEntry(
      LedgerDirection.Debit,
      '100.00',
      '80.00',
      '20.00',
    );

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-001');
    expect(entry.transactionId).toBe('transaction-001');
  });

  it('deve validar um crédito correto', () => {
    const entry = createEntry(
      LedgerDirection.Credit,
      '100.00',
      '50.00',
      '150.00',
    );

    expect(entry.isBalanced()).toBe(true);
  });

  it('deve rejeitar saldo posterior incorreto', () => {
    expect(() =>
      createEntry(
        LedgerDirection.Debit,
        '100.00',
        '80.00',
        '30.00',
      ),
    ).toThrow();
  });

  it('deve rejeitar crédito com cálculo incorreto', () => {
    expect(() =>
      createEntry(
        LedgerDirection.Credit,
        '100.00',
        '50.00',
        '140.00',
      ),
    ).toThrow();
  });

  it('deve rejeitar movimentação de valor zero', () => {
    expect(() =>
      createEntry(
        LedgerDirection.Credit,
        '100.00',
        '0.00',
        '100.00',
      ),
    ).toThrow();
  });

  it('deve proteger a data contra alterações externas', () => {
    const originalDate = new Date('2026-11-03T12:00:00Z');

    const entry = WalletLedgerEntry.create({
      id: 'ledger-001',
      walletId: 'wallet-001',
      transactionId: 'transaction-001',
      direction: LedgerDirection.Debit,
      money: brl('20.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('80.00'),
      createdAt: originalDate,
    });

    originalDate.setTime(0);

    const externalDate = entry.createdAt;
    externalDate.setTime(0);

    expect(entry.createdAt.toISOString())
      .toBe('2026-11-03T12:00:00.000Z');

    expect(Reflect.get(entry, '_createdAt'))
      .toBeUndefined();
  });

  it('deve rejeitar uma data inválida', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-001',
        walletId: 'wallet-001',
        transactionId: 'transaction-001',
        direction: LedgerDirection.Debit,
        money: brl('20.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
        createdAt: new Date('invalid'),
      }),
    ).toThrow();
  });

  it('deve rejeitar movimentação monetária negativa', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-001',
        walletId: 'wallet-001',
        transactionId: 'transaction-001',
        direction: LedgerDirection.Debit,
        money: brl('20.00').negate(),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('120.00'),
        createdAt: new Date('2026-11-03T12:00:00Z'),
      }),
    ).toThrow();
  });
});
