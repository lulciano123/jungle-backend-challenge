import { Money } from '../value-objects/money.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export class Wallet {
  private _balance: Money;
  private _version: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    initialBalance: Money,
  ) {
    this._balance = initialBalance;
    this._version = 1;
  }

  static open(props: OpenWalletProps): Wallet {
    if (!props.id?.trim()) {
      throw new Error('Identificador da carteira inválido');
    }

    if (!props.playerId?.trim()) {
      throw new Error('Identificador do jogador inválido');
    }

    if (!(props.initialBalance instanceof Money)) {
      throw new Error('Saldo inicial inválido');
    }

    if (props.initialBalance.isNegative()) {
      throw new Error('Saldo inicial não pode ser negativo');
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get currency(): string {
    return this._balance.currency;
  }

  get version(): number {
    return this._version;
  }

  credit(amount: Money): void {
    this.validateMovement(amount);

    // Calcula primeiro. Se houver overflow,
    // o estado da carteira permanece inalterado.
    const nextBalance = this._balance.add(amount);

    this._balance = nextBalance;
    this._version++;
  }

  debit(amount: Money): void {
    this.validateMovement(amount);

    if (this._balance.isLessThan(amount)) {
      throw new Error('Saldo insuficiente');
    }

    const nextBalance = this._balance.subtract(amount);

    this._balance = nextBalance;
    this._version++;
  }

  private validateMovement(amount: Money): void {
    if (!(amount instanceof Money)) {
      throw new Error('Movimentação monetária inválida');
    }

    if (amount.currency !== this.currency) {
      throw new Error('Moeda incompatível com a carteira');
    }

    if (!amount.isPositive()) {
      throw new Error(
        'Movimentação deve possuir valor positivo',
      );
    }
  }
}
