import { Money } from '../value-objects/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    // Copia a data para evitar alterações externas.
    this._createdAt = new Date(createdAt.getTime());

    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (
      !props.id?.trim() ||
      !props.walletId?.trim() ||
      !props.transactionId?.trim()
    ) {
      throw new Error('Identificadores do ledger inválidos');
    }

    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new Error('Direção do ledger inválida');
    }

    if (
      !(props.money instanceof Money) ||
      !(props.balanceBefore instanceof Money) ||
      !(props.balanceAfter instanceof Money)
    ) {
      throw new Error('Valores monetários inválidos');
    }

    if (!props.money.isPositive()) {
      throw new Error('Movimentação deve ser positiva');
    }

    const currency = props.money.currency;

    if (
      props.balanceBefore.currency !== currency ||
      props.balanceAfter.currency !== currency
    ) {
      throw new Error('Moedas incompatíveis no ledger');
    }

    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new Error('Saldo negativo no ledger');
    }

    if (
      !(props.createdAt instanceof Date) ||
      !Number.isFinite(props.createdAt.getTime())
    ) {
      throw new Error('Data do ledger inválida');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new Error('Lançamento financeiro não fecha');
    }

    return entry;
  }

  // Reconstrói um lançamento já persistido.
  // Não reexecuta as regras de criação.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    // Retorna cópia para proteger a data interna.
    return new Date(this._createdAt.getTime());
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.direction === LedgerDirection.Credit
          ? this.balanceBefore.add(this.money)
          : null;

    return (
      expectedBalance !== null &&
      expectedBalance.equals(this.balanceAfter)
    );
  }
}
