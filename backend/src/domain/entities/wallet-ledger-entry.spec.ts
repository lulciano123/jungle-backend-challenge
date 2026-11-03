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
});
