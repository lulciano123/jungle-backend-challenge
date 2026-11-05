import { Migration } from '@mikro-orm/migrations';

export class Migration20261104000002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL CHECK (length(btrim(consumer_name)) > 0),
        message_id text NOT NULL CHECK (length(btrim(message_id)) > 0),
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        processed_at timestamptz,
        transaction_id uuid REFERENCES wager_transactions(id),
        PRIMARY KEY (consumer_name, message_id),
        CHECK (processed_at IS NULL OR processed_at >= received_at),
        CHECK ((processed_at IS NULL) = (transaction_id IS NULL))
      );
      CREATE INDEX inbox_messages_transaction_idx ON inbox_messages(transaction_id);
      CREATE INDEX inbox_messages_unprocessed_idx ON inbox_messages(received_at)
        WHERE processed_at IS NULL;

      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL REFERENCES wallets(id),
        event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        published_at timestamptz,
        claim_token uuid,
        claimed_until timestamptz,
        last_error text,
        CHECK ((claim_token IS NULL) = (claimed_until IS NULL)),
        CHECK (published_at IS NULL OR claim_token IS NULL),
        CHECK (jsonb_typeof(payload) = 'object'),
        CHECK (payload->>'eventId' IS NOT NULL AND payload->>'eventId' = id::text),
        CHECK (payload->>'aggregateId' IS NOT NULL AND payload->>'aggregateId' = aggregate_id::text),
        CHECK (payload->>'eventType' IS NOT NULL AND payload->>'eventType' = event_type),
        CHECK (payload->'data' IS NOT NULL AND jsonb_typeof(payload->'data') = 'object'),
        CHECK (payload->>'version' IS NOT NULL AND (payload->>'version')::integer >= 1),
        CHECK (payload->>'correlationId' IS NOT NULL AND length(btrim(payload->>'correlationId')) > 0),
        CHECK (payload->>'occurredAt' IS NOT NULL AND (payload->>'occurredAt')::timestamptz = occurred_at)
      );
      CREATE INDEX outbox_messages_pending_idx ON outbox_messages(next_attempt_at, occurred_at, id)
        WHERE published_at IS NULL;
      CREATE INDEX outbox_messages_aggregate_idx ON outbox_messages(aggregate_id, occurred_at, id);
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE outbox_messages; DROP TABLE inbox_messages;');
  }
}
