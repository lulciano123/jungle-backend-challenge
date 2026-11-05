import { describe, expect, it } from 'vitest';
import { parseWagerRequest } from './wager-request.js';
import {
  permanentFailureCode,
  retrySeconds,
} from '../../infrastructure/sqs/wager-consumer.js';
import { InboxPayloadConflictError } from './inbox-processor.js';
import { IdempotencyConflictError } from '../services/betting.service.js';

const envelope = {
  messageId: 'msg',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-11-04T00:00:00.000Z',
  data: {
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    playerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    walletId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  },
};

describe('Wager request envelope', () => {
  it('accepts the official envelope and hashes independently of JSON property order', () => {
    const a = parseWagerRequest(JSON.stringify(envelope));
    const b = parseWagerRequest(
      JSON.stringify({
        data: { ...envelope.data, money: { currency: 'BRL', amount: '1.00' } },
        ...Object.fromEntries(
          Object.entries(envelope)
            .filter(([key]) => key !== 'data')
            .reverse(),
        ),
      }),
    );
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.command.idempotencyKey).toBe('key');
    expect(a.correlationId).toBe('key');
    for (const occurredAt of [
      '2026-11-04T00:00:00Z',
      '2026-11-04T03:00:00+03:00',
    ]) {
      expect(() =>
        parseWagerRequest(JSON.stringify({ ...envelope, occurredAt })),
      ).not.toThrow();
    }
  });

  it.each([
    '{',
    'null',
    '[]',
    JSON.stringify({ ...envelope, type: 'WalletBalanceChanged' }),
    JSON.stringify({ ...envelope, version: 2 }),
    JSON.stringify({ ...envelope, messageId: '' }),
    JSON.stringify({ ...envelope, occurredAt: '2026-02-30T00:00:00.000Z' }),
    JSON.stringify({ ...envelope, occurredAt: 'yesterday' }),
  ])('rejects permanent malformed envelope: %s', (body) => {
    try {
      parseWagerRequest(body);
      throw new Error('Expected envelope rejection');
    } catch (error) {
      expect(permanentFailureCode(error)).toBe('INVALID_ENVELOPE');
    }
  });

  it.each([
    { ...envelope.data, kind: 'OPENING' },
    { ...envelope.data, idempotencyKey: undefined },
    { ...envelope.data, roundId: undefined },
    { ...envelope.data, money: { amount: 1, currency: 'BRL' } },
    { ...envelope.data, kind: 'REFUND' },
  ])(
    'rejects malformed financial input through the shared HTTP parser',
    (data) => {
      expect(() =>
        parseWagerRequest(JSON.stringify({ ...envelope, data })),
      ).toThrow();
    },
  );

  it('distinguishes permanent conflicts from SQL/network failures and bounds retry delay', () => {
    expect(permanentFailureCode(new InboxPayloadConflictError())).toBe(
      'INBOX_PAYLOAD_CONFLICT',
    );
    expect(permanentFailureCode(new IdempotencyConflictError())).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(permanentFailureCode(new Error('ECONNREFUSED'))).toBeUndefined();
    expect(
      permanentFailureCode(new Error('deadlock detected')),
    ).toBeUndefined();
    expect(retrySeconds(1)).toBe(2);
    expect(retrySeconds(100)).toBeLessThanOrEqual(300);
  });
});
