import { createHash } from 'node:crypto';
import type { SubmitWagerCommand } from '../services/betting.service.js';
import {
  InvalidWagerPayloadError,
  parseWagerCommand,
} from './parse-wager-command.js';

export class InvalidEnvelopeError extends Error {
  readonly code = 'INVALID_ENVELOPE';
}

export interface WagerRequest {
  messageId: string;
  correlationId: string;
  command: SubmitWagerCommand;
  payloadHash: string;
}

function isTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  // Reject calendar rollover (e.g. February 30), without requiring one ISO spelling/timezone.
  return (
    new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 19) ===
    value.slice(0, 19)
  );
}

// Sorting is recursive, so JSON property order does not change Inbox identity.
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseWagerRequest(body: string): WagerRequest {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidEnvelopeError('Invalid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidEnvelopeError('Envelope must be an object');
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.type !== 'WagerTransactionRequested' ||
    typeof envelope.messageId !== 'string' ||
    envelope.messageId.trim() === '' ||
    !isTimestamp(envelope.occurredAt) ||
    (envelope.version !== undefined && envelope.version !== 1) ||
    (envelope.correlationId !== undefined &&
      (typeof envelope.correlationId !== 'string' ||
        envelope.correlationId.trim() === ''))
  )
    throw new InvalidEnvelopeError(
      'Invalid WagerTransactionRequested envelope',
    );

  const data = envelope.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InvalidWagerPayloadError({
      code: 'INVALID_PAYLOAD',
      message: 'data must be an object',
    });
  }
  const command = parseWagerCommand(
    data,
    (data as Record<string, unknown>).idempotencyKey,
  );
  return {
    messageId: envelope.messageId,
    correlationId:
      typeof envelope.correlationId === 'string'
        ? envelope.correlationId
        : command.idempotencyKey,
    command,
    payloadHash: createHash('sha256')
      .update(canonicalJSON(envelope))
      .digest('hex'),
  };
}
