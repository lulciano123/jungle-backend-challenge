
import { describe, expect, it } from 'vitest';
import { Money } from '../value-objects/money.js';
import { Wallet } from './wallet.js';

describe('Wallet - Integridade e reconstrução', () => {
  const brl = (amount: string) =>
    Money.from({ amount, currency: 'BRL' });

  const createWallet = () =>
    Wallet.open({
      id: 'wallet-001',
      playerId: 'player-001',
      initialBalance: brl('100.00'),
    });

  it('não deve permitir adulterar o saldo por reflexão', () => {
    const wallet = createWallet();

    Reflect.set(wallet, '_balance', brl('999.00'));

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  it('não deve permitir adulterar a versão por reflexão', () => {
    const wallet = createWallet();

    Reflect.set(wallet, '_version', 999);

    expect(wallet.version).toBe(1);

    wallet.debit(brl('20.00'));

    expect(wallet.balance.toJSON().amount).toBe('80.00');
    expect(wallet.version).toBe(2);
  });

  it('não deve permitir alterar a identidade da carteira', () => {
    const wallet = createWallet();

    Reflect.set(wallet, 'id', 'wallet-falsa');
    Reflect.set(wallet, 'playerId', 'player-falso');

    expect(wallet.id).toBe('wallet-001');
    expect(wallet.playerId).toBe('player-001');
  });

  it('deve reconstruir a carteira preservando a versão', () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const updatedAt = new Date('2026-10-02T15:00:00Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-001',
      playerId: 'player-001',
      balance: brl('75.00'),
      version: 17,
      createdAt,
      updatedAt,
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(17);

    wallet.credit(brl('10.00'));

    expect(wallet.balance.toJSON().amount).toBe('85.00');
    expect(wallet.version).toBe(18);
  });

  it('deve proteger os timestamps contra alterações externas', () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const updatedAt = new Date('2026-10-02T15:00:00Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-001',
      playerId: 'player-001',
      balance: brl('75.00'),
      version: 3,
      createdAt,
      updatedAt,
    });

    createdAt.setTime(0);
    updatedAt.setTime(0);

    const externalDate = wallet.createdAt;
    externalDate.setTime(0);

    expect(wallet.createdAt.toISOString())
      .toBe('2026-10-01T10:00:00.000Z');

    expect(wallet.updatedAt.toISOString())
      .toBe('2026-10-02T15:00:00.000Z');
  });
});
