
import { Migration } from '@mikro-orm/migrations';

export class Migration20261104000000 extends Migration {
  async up(): Promise<void> {
    // 1. Carteiras: saldo materializado e versão.
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallets_currency_check
          CHECK (currency IN ('BRL', 'USD')),

        CONSTRAINT wallets_balance_check
          CHECK (
            balance >= 0
            AND balance <= 999999999999999999.99
          ),

        CONSTRAINT wallets_version_check
          CHECK (version >= 1),

        CONSTRAINT wallets_dates_check
          CHECK (updated_at >= created_at),

        CONSTRAINT wallets_player_currency_unique
          UNIQUE (player_id, currency),

        CONSTRAINT wallets_id_currency_unique
          UNIQUE (id, currency)
      );
    `);

    // 2. Transações: estado e idempotência persistentes.
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        player_id UUID NOT NULL,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        round_id TEXT,
        game_id TEXT,
        kind VARCHAR(16) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id TEXT,
        reference_transaction_id UUID,
        failure_code TEXT,
        result_balance NUMERIC(20, 2),
        original_response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,

        CONSTRAINT wager_transactions_kind_check
          CHECK (
            kind IN (
              'OPENING', 'BET', 'WIN',
              'LOSS', 'REFUND', 'ROLLBACK'
            )
          ),

        CONSTRAINT wager_transactions_status_check
          CHECK (
            status IN (
              'PENDING', 'PENDING_REFERENCE',
              'PROCESSED', 'REJECTED', 'FAILED'
            )
          ),

        CONSTRAINT wager_transactions_currency_check
          CHECK (currency IN ('BRL', 'USD')),

        CONSTRAINT wager_transactions_amount_check
          CHECK (
            amount > 0
            AND amount <= 999999999999999999.99
          ),

        CONSTRAINT wager_transactions_result_balance_check
          CHECK (
            result_balance IS NULL OR (
              result_balance >= 0
              AND result_balance <= 999999999999999999.99
            )
          ),

        CONSTRAINT wager_transactions_reference_check
          CHECK (
            kind NOT IN ('REFUND', 'ROLLBACK')
            OR reference_external_transaction_id IS NOT NULL
          ),

        CONSTRAINT wager_transactions_wallet_fk
          FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),

        CONSTRAINT wager_transactions_reference_fk
          FOREIGN KEY (reference_transaction_id)
          REFERENCES wager_transactions (id),

        CONSTRAINT wager_transactions_provider_external_unique
          UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_transactions_idempotency_unique
          UNIQUE (idempotency_key),

        CONSTRAINT wager_transactions_id_currency_unique
          UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
      ON wager_transactions (created_at, id)
      WHERE status = 'PENDING_REFERENCE';
    `);

    // Impede duas reversões processadas do mesmo tipo
    // para a mesma transação de referência.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_reversal_unique
      ON wager_transactions (reference_transaction_id, kind)
      WHERE (
        status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
      );
    `);

    // 3. Ledger: histórico financeiro imutável.
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(6) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallet_ledger_direction_check
          CHECK (direction IN ('DEBIT', 'CREDIT')),

        CONSTRAINT wallet_ledger_amount_check
          CHECK (
            amount > 0
            AND amount <= 999999999999999999.99
          ),

        CONSTRAINT wallet_ledger_balances_check
          CHECK (
            balance_before >= 0
            AND balance_after >= 0
            AND balance_before <= 999999999999999999.99
            AND balance_after <= 999999999999999999.99
          ),

        CONSTRAINT wallet_ledger_arithmetic_check
          CHECK (
            (direction = 'DEBIT'
              AND balance_after = balance_before - amount)
            OR
            (direction = 'CREDIT'
              AND balance_after = balance_before + amount)
          ),

        CONSTRAINT wallet_ledger_wallet_fk
          FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),

        CONSTRAINT wallet_ledger_transaction_fk
          FOREIGN KEY (transaction_id, currency)
          REFERENCES wager_transactions (id, currency),

        CONSTRAINT wallet_ledger_transaction_wallet_unique
          UNIQUE (transaction_id, wallet_id)
      );
    `);

    // Índice para paginação estável do extrato.
    this.addSql(`
      CREATE INDEX wallet_ledger_wallet_cursor_idx
      ON wallet_ledger_entries (wallet_id, created_at, id);
    `);

    // Proíbe UPDATE e DELETE de lançamentos.
    this.addSql(`
      CREATE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'Wallet ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_immutable_trigger
      BEFORE UPDATE OR DELETE
      ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);

    // Também impede esvaziar o ledger com TRUNCATE.
    this.addSql(`
      CREATE TRIGGER wallet_ledger_no_truncate_trigger
      BEFORE TRUNCATE
      ON wallet_ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);
  }

  // Reversão da migration, usada somente em
  // procedimentos administrativos controlados.
  async down(): Promise<void> {
    this.addSql('DROP TABLE wallet_ledger_entries;');
    this.addSql('DROP FUNCTION prevent_wallet_ledger_mutation();');
    this.addSql('DROP TABLE wager_transactions;');
    this.addSql('DROP TABLE wallets;');
  }
}
