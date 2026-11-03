import { describe, expect, it } from 'vitest';
import { Money } from '../value-objects/money.js';
import { Wallet } from './wallet.js';

describe('Wallet', () => {
  const brl = (amount: string) =>
    Money.from({ amount, currency: 'BRL' });

  const createWallet = (initial = '100.00') =>
    Wallet.open({
      id: 'wallet-001',
      playerId: 'player-001',
      initialBalance: brl(initial),
    });

  it('deve abrir uma carteira com saldo e versão inicial', () => {
    const wallet = createWallet();

    expect(wallet.id).toBe('wallet-001');
    expect(wallet.playerId).toBe('player-001');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('deve permitir carteira com saldo inicial zero', () => {
    const wallet = createWallet('0.00');

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('deve debitar um valor disponível', () => {
    const wallet = createWallet();

    wallet.debit(brl('80.00'));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('deve rejeitar débito com saldo insuficiente', () => {
    const wallet = createWallet();

    expect(() => wallet.debit(brl('150.00'))).toThrow();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('deve creditar um valor corretamente', () => {
    const wallet = createWallet();

    wallet.credit(brl('50.00'));

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  it('deve rejeitar operações com moeda diferente', () => {
    const wallet = createWallet();

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => wallet.credit(usd)).toThrow();
    expect(() => wallet.debit(usd)).toThrow();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('deve rejeitar movimentações de valor zero', () => {
    const wallet = createWallet();

    expect(() => wallet.credit(brl('0.00'))).toThrow();
    expect(() => wallet.debit(brl('0.00'))).toThrow();

    expect(wallet.version).toBe(1);
  });

  it('deve incrementar a versão a cada alteração válida', () => {
    const wallet = createWallet();

    wallet.debit(brl('30.00'));
    wallet.credit(brl('15.00'));

    expect(wallet.balance.toJSON().amount).toBe('85.00');
    expect(wallet.version).toBe(3);
  });

  it('deve rejeitar movimentações internas negativas', () => {
    const wallet = createWallet();
    const negative = brl('10.00').negate();

    expect(() => wallet.credit(negative)).toThrow();
    expect(() => wallet.debit(negative)).toThrow();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
it('deve permitir debitar exatamente todo o saldo', () => {
    const wallet = createWallet('100.00');

    wallet.debit(brl('100.00'));

    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(2);

    expect(() => wallet.debit(brl('0.01'))).toThrow();
    expect(wallet.version).toBe(2);
  });

  it('deve preservar o estado quando um crédito causa overflow', () => {
    const wallet = createWallet('999999999999999999.99');

    expect(() => wallet.credit(brl('0.01')))
      .toThrow(RangeError);

    expect(wallet.balance.toJSON().amount)
      .toBe('999999999999999999.99');

    expect(wallet.version).toBe(1);
  });

  it('deve rejeitar abertura com saldo negativo', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-invalid',
        playerId: 'player-001',
        initialBalance: brl('10.00').negate(),
      }),
    ).toThrow();
  });

  it('deve rejeitar identificadores vazios', () => {
    expect(() =>
      Wallet.open({
        id: '   ',
        playerId: 'player-001',
        initialBalance: brl('10.00'),
      }),
    ).toThrow();

    expect(() =>
      Wallet.open({
        id: 'wallet-001',
        playerId: '',
        initialBalance: brl('10.00'),
      }),
    ).toThrow();
  });

  it('deve manter precisão após mil débitos de um centavo', () => {
    const wallet = createWallet('10.00');

    for (let i = 0; i < 1000; i++) {
      wallet.debit(brl('0.01'));
    }

    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(1001);

    expect(() => wallet.debit(brl('0.01'))).toThrow();

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1001);
  });
});
