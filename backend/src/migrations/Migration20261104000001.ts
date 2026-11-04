
import { Migration } from '@mikro-orm/migrations';

export class Migration20261104000001 extends Migration {
  async up(): Promise<void> {
    // 1. Permite que o PostgreSQL valide conjuntamente
    // a transação, sua carteira e sua moeda.
    //
    // A PK de id já garante unicidade, mas uma FK
    // composta precisa referenciar um conjunto de
    // colunas com UNIQUE ou PRIMARY KEY.
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_id_wallet_currency_unique
      UNIQUE (id, wallet_id, currency);
    `);

    // 2. O ledger não pode apontar para uma transação
    // pertencente a outra carteira, mesmo se ambas
    // usarem a mesma moeda.
    //
    // Mantemos as FKs anteriores; esta acrescenta
    // a garantia relacional que estava faltando.
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      ADD CONSTRAINT wallet_ledger_transaction_wallet_currency_fk
      FOREIGN KEY (transaction_id, wallet_id, currency)
      REFERENCES wager_transactions (id, wallet_id, currency);
    `);

    // 3. Uma reversão concluída precisa ter uma
    // transação original identificada internamente.
    //
    // PENDING_REFERENCE continua permitido com
    // reference_transaction_id NULL, pois a referência
    // ainda pode não ter chegado ao sistema.
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_processed_reversal_reference_check
      CHECK (
        kind NOT IN ('REFUND', 'ROLLBACK')
        OR status <> 'PROCESSED'
        OR reference_transaction_id IS NOT NULL
      );
    `);
  }

  async down(): Promise<void> {
    // Reverte apenas as restrições desta migration,
    // na ordem inversa da criação.
    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT wager_transactions_processed_reversal_reference_check;
    `);

    this.addSql(`
      ALTER TABLE wallet_ledger_entries
      DROP CONSTRAINT wallet_ledger_transaction_wallet_currency_fk;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT wager_transactions_id_wallet_currency_unique;
    `);
  }
}
