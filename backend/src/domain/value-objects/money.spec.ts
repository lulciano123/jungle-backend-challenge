
import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  const brl = (amount: string) =>
    Money.from({ amount, currency: 'BRL' });

  // ==========================================
  // 1. REPRESENTAÇÃO E PRECISÃO
  // ==========================================

  it('deve representar dinheiro com duas casas decimais', () => {
    const money = brl('25.00');

    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('deve somar valores sem erro de precisão', () => {
    const result = brl('0.10').add(brl('0.20'));

    expect(result.toJSON().amount).toBe('0.30');
  });

  it('deve subtrair valores corretamente', () => {
    const result = brl('100.00').subtract(brl('80.00'));

    expect(result.toJSON().amount).toBe('20.00');
  });

  it('deve permitir valores internos negativos', () => {
    const result = brl('10.00').negate();

    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-10.00');
  });

  it('deve rejeitar valores negativos na entrada', () => {
    expect(() => brl('-10.00')).toThrow();
  });

  it('deve rejeitar valores com mais de duas casas', () => {
    expect(() => brl('1.999')).toThrow();
  });

  // ==========================================
  // 2. VALIDAÇÃO DE ENTRADAS
  // ==========================================

  it('deve rejeitar valores inválidos', () => {
    for (const amount of ['', 'NaN', 'Infinity', '1e3']) {
      expect(() => brl(amount)).toThrow();
    }
  });

  it('deve rejeitar formatos monetários incorretos', () => {
    const invalidos = [
      '01.00',
      '1.0',
      '1.000',
      '+1.00',
      ' 1.00',
      '1.00 ',
      '1e3',
    ];

    for (const valor of invalidos) {
      expect(() => brl(valor)).toThrow();
    }
  });

  it('deve validar o formato da moeda', () => {
    const invalidas = ['brl', 'BR', 'BRLL', ' BRL'];

    for (const currency of invalidas) {
      expect(() =>
        Money.from({
          amount: '10.00',
          currency,
        }),
      ).toThrow();
    }
  });

  // ==========================================
  // 3. COMPATIBILIDADE ENTRE MOEDAS
  // ==========================================

  it('deve rejeitar operações entre moedas diferentes', () => {
    const reais = brl('10.00');

    const dolares = Money.from({
      amount: '5.00',
      currency: 'USD',
    });

    expect(() => reais.add(dolares)).toThrow();
    expect(() => reais.subtract(dolares)).toThrow();
  });

  it('deve impedir comparação entre moedas diferentes', () => {
    const reais = brl('10.00');

    const dolares = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => reais.isLessThan(dolares)).toThrow();
    expect(reais.equals(dolares)).toBe(false);
  });

  // ==========================================
  // 4. IMUTABILIDADE E VALORES ESPECIAIS
  // ==========================================

  it('não deve modificar os valores originais', () => {
    const original = brl('100.00');
    const result = original.subtract(brl('30.00'));

    expect(original.toJSON().amount).toBe('100.00');
    expect(result.toJSON().amount).toBe('70.00');
    expect(result).not.toBe(original);
  });

  it('deve criar um valor zero na moeda informada', () => {
    const zero = Money.zero('BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  });

  // ==========================================
  // 5. LIMITES E OVERFLOW
  // ==========================================

  it('deve aceitar o maior valor permitido', () => {
    const money = brl('999999999999999999.99');

    expect(money.toJSON().amount)
      .toBe('999999999999999999.99');
  });

  it('deve rejeitar overflow em operações', () => {
    const maximo = brl('999999999999999999.99');
    const centavo = brl('0.01');

    expect(() => maximo.add(centavo))
      .toThrow(RangeError);
  });

  // ==========================================
  // 6. COMPARAÇÕES
  // ==========================================

  it('deve comparar valores corretamente', () => {
    expect(brl('10.00').isLessThan(brl('20.00')))
      .toBe(true);

    expect(brl('20.00').isLessThan(brl('10.00')))
      .toBe(false);

    expect(brl('10.00').equals(brl('10.00')))
      .toBe(true);

    expect(brl('10.00').equals(brl('20.00')))
      .toBe(false);
  });
});
