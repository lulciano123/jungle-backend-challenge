
import { Money } from '../value-objects/money.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  // Campos privados reais do JavaScript.
  readonly #id: string;
  readonly #playerId: string;

  #balance: Money;
  #version: number;

  // Timestamps armazenados como primitivos imutáveis.
  readonly #createdAtMs: number;
  #updatedAtMs: number;

  private constructor(state: WalletState) {
    this.#id = state.id;
    this.#playerId = state.playerId;
    this.#balance = state.balance;
    this.#version = state.version;

    this.#createdAtMs = state.createdAt.getTime();
    this.#updatedAtMs = state.updatedAt.getTime();

    // Impede criação ou substituição de
    // propriedades públicas em runtime.
    Object.freeze(this);
  }

  // Cria uma carteira nova.
  static open(props: OpenWalletProps): Wallet {
    const now = new Date();

    const state: WalletState = {
      id: props.id,
      playerId: props.playerId,
      balance: props.initialBalance,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    Wallet.validateState(state);

    return new Wallet(state);
  }

  // Reconstrói uma carteira existente no banco.
  // Preserva versão, saldo e timestamps originais.
  static rehydrate(state: WalletState): Wallet {
    Wallet.validateState(state);

    return new Wallet(state);
  }

  get id(): string {
    return this.#id;
  }

  get playerId(): string {
    return this.#playerId;
  }

  get balance(): Money {
    return this.#balance;
  }

  get currency(): string {
    return this.#balance.currency;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAtMs);
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAtMs);
  }

  credit(amount: Money): void {
    this.validateMovement(amount);

    // Calcula antes de modificar o estado.
    const nextBalance = this.#balance.add(amount);

    this.commitBalanceChange(nextBalance);
  }

  debit(amount: Money): void {
    this.validateMovement(amount);

    if (this.#balance.isLessThan(amount)) {
      throw new Error('Saldo insuficiente');
    }

    // Calcula antes de modificar o estado.
    const nextBalance = this.#balance.subtract(amount);

    this.commitBalanceChange(nextBalance);
  }

  private commitBalanceChange(nextBalance: Money): void {
    if (!Number.isSafeInteger(this.#version + 1)) {
      throw new RangeError('Versão da carteira fora dos limites');
    }

    this.#balance = nextBalance;
    this.#version += 1;

    // Mantém updatedAt monotônico, inclusive
    // em operações executadas no mesmo milissegundo.
    this.#updatedAtMs = Math.max(
      Date.now(),
      this.#updatedAtMs + 1,
    );
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

  private static validateState(state: WalletState): void {
    if (
      typeof state?.id !== 'string' ||
      !state.id.trim()
    ) {
      throw new Error('Identificador da carteira inválido');
    }

    if (
      typeof state.playerId !== 'string' ||
      !state.playerId.trim()
    ) {
      throw new Error('Identificador do jogador inválido');
    }

    if (!(state.balance instanceof Money)) {
      throw new Error('Saldo da carteira inválido');
    }

    if (state.balance.isNegative()) {
      throw new Error('Saldo inicial não pode ser negativo');
    }

    if (
      !Number.isSafeInteger(state.version) ||
      state.version < 1
    ) {
      throw new Error('Versão da carteira inválida');
    }

    if (
      !(state.createdAt instanceof Date) ||
      !Number.isFinite(state.createdAt.getTime())
    ) {
      throw new Error('Data de criação inválida');
    }

    if (
      !(state.updatedAt instanceof Date) ||
      !Number.isFinite(state.updatedAt.getTime())
    ) {
      throw new Error('Data de atualização inválida');
    }

    if (state.updatedAt.getTime() < state.createdAt.getTime()) {
      throw new Error(
        'Data de atualização anterior à criação',
      );
    }
  }
}
