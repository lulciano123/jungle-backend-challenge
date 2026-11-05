import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../value-objects/money.js';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  readonly #occurredAt: string;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.#occurredAt = props.occurredAt.toISOString();
    this.data = deepFreeze(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined
        ? {}
        : { causationId: this.causationId }),
      occurredAt: this.#occurredAt,
      data: this.data,
    };
  }
}

export interface WagerTransactionData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string | null;
  gameId: string | null;
  kind: 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: MoneyProps;
  balance: MoneyProps;
  referenceExternalTransactionId: string | null;
}

function props<T extends { walletId: string }>(
  data: T,
  ctx: EventContext,
): IntegrationEventProps<T> {
  return {
    ...ctx,
    eventId: randomUUID(),
    aggregateId: data.walletId,
    occurredAt: new Date(),
    data,
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(p: IntegrationEventProps<WagerTransactionData>) {
    super(p);
    Object.freeze(this);
  }
  static from(
    data: WagerTransactionData,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props(data, ctx));
  }
}

export class WagerTransactionRejected extends IntegrationEvent<
  WagerTransactionData & { failureCode: string }
> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(
    p: IntegrationEventProps<WagerTransactionData & { failureCode: string }>,
  ) {
    super(p);
    Object.freeze(this);
  }
  static from(
    data: WagerTransactionData & { failureCode: string },
    ctx: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(props(data, ctx));
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(p: IntegrationEventProps<WagerTransactionData>) {
    super(p);
    Object.freeze(this);
  }
  static from(
    data: WagerTransactionData,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props(data, ctx));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  // BIGINT is serialized as a string to preserve versions beyond Number.MAX_SAFE_INTEGER.
  walletVersion: string;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(p: IntegrationEventProps<WalletBalanceChangedData>) {
    super(p);
    Object.freeze(this);
  }
  static from(
    data: WalletBalanceChangedData,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(props(data, ctx));
  }
}
