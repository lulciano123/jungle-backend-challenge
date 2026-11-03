import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Configuração isolada para cálculos monetários.
const MoneyDecimal = Decimal.clone({ precision: 40 });

// Limite escolhido para compatibilidade futura
// com uma coluna NUMERIC(20, 2) no PostgreSQL.
const MAX_AMOUNT = new MoneyDecimal('999999999999999999.99');

// Exige valores como "0.00", "25.50" e "100.00".
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (!value.isFinite() || value.abs().greaterThan(MAX_AMOUNT)) {
      throw new RangeError('Valor monetário fora dos limites');
    }

    if (value.decimalPlaces() > 2) {
      throw new Error('Valor monetário com precisão inválida');
    }

    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props?.currency !== 'string' ||
      !CURRENCY_PATTERN.test(props.currency)
    ) {
      throw new Error('Moeda inválida');
    }

    if (
      typeof props.amount !== 'string' ||
      !AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new Error('Valor monetário inválido');
    }

    return new Money(
      new MoneyDecimal(props.amount),
      props.currency,
    );
  }

  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.plus(other.value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.minus(other.value),
      this.currency,
    );
  }

  negate(): Money {
    return new Money(
      this.value.negated(),
      this.currency,
    );
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.value.equals(other.value)
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('Operação entre moedas diferentes');
    }
  }
}
