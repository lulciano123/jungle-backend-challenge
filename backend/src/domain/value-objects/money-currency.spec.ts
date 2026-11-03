import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money - Validação de moedas', () => {
  it('deve aceitar BRL e USD', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(brl.currency).toBe('BRL');
    expect(usd.currency).toBe('USD');
  });

  it('deve rejeitar códigos de moeda não suportados', () => {
    for (const currency of ['ABC', 'ZZZ', 'XXX']) {
      expect(() =>
        Money.from({
          amount: '10.00',
          currency,
        }),
      ).toThrow('Moeda não suportada');
    }
  });

  it('deve rejeitar zero com moeda não suportada', () => {
    expect(() => Money.zero('ZZZ'))
      .toThrow('Moeda não suportada');
  });
});
