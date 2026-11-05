import { randomUUID } from 'node:crypto';
import { MikroORM, type Options } from '@mikro-orm/postgresql';
import ormConfig from '../../src/mikro-orm.config.js';
import { Migration20261104000000 } from '../../src/migrations/Migration20261104000000.js';
import { Migration20261104000001 } from '../../src/migrations/Migration20261104000001.js';
import { Migration20261104000002 } from '../../src/migrations/Migration20261104000002.js';
import { WalletsService } from '../../src/application/services/wallets.service.js';
import type { SubmitWagerCommand } from '../../src/application/services/betting.service.js';

export async function isolatedDatabase(): Promise<{
  orm: MikroORM;
  config: Options;
  schema: string;
}> {
  if (process.env.DB_NAME !== 'jungle_wagering_test')
    throw new Error('Messaging tests require DB_NAME=jungle_wagering_test');
  const schema = `messaging_${randomUUID().replaceAll('-', '')}`;
  const admin = await MikroORM.init({
    ...ormConfig,
    dbName: 'jungle_wagering_test',
  });
  try {
    await admin.em.fork().execute(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.close();
  }
  const config: Options = {
    ...ormConfig,
    dbName: 'jungle_wagering_test',
    schema,
    driverOptions: { options: `-c search_path=${schema}` },
    migrations: {
      ...ormConfig.migrations,
      snapshot: false,
      migrationsList: [
        Migration20261104000000,
        Migration20261104000001,
        Migration20261104000002,
      ],
    },
  };
  const orm = await MikroORM.init(config);
  try {
    const [location] = await orm.em
      .fork()
      .execute<Array<{ db: string; schema: string }>>(
        'SELECT current_database() AS db, current_schema() AS schema',
      );
    if (location.db !== 'jungle_wagering_test' || location.schema !== schema)
      throw new Error('Unsafe messaging test connection');
    await orm.migrator.up();
    return { orm, config, schema };
  } catch (error) {
    await orm.close();
    throw error;
  }
  // Retain this isolated test schema and its financial audit records; never truncate/drop them.
}

export async function fixture(
  orm: MikroORM,
  kind: SubmitWagerCommand['kind'] = 'BET',
  amount = '25.00',
) {
  const playerId = randomUUID();
  const wallet = await new WalletsService(orm.em.fork()).open({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const command: SubmitWagerCommand = {
    walletId: wallet.id,
    playerId,
    providerId: 'messaging-test',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    roundId: 'round-messaging',
    gameId: 'game-messaging',
    kind,
    amount,
    currency: 'BRL',
  };
  const messageId = randomUUID();
  return { command, messageId, body: requestBody(command, messageId) };
}

export function requestBody(
  command: SubmitWagerCommand,
  messageId = randomUUID(),
): string {
  const { amount, currency, ...fields } = command;
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-04T00:00:00.000Z',
    data: { ...fields, money: { amount, currency } },
  });
}

export async function snapshot(
  orm: MikroORM,
  walletId: string,
  messageId: string,
) {
  const [row] = await orm.em.fork().execute<
    Array<{
      balance: string;
      version: string;
      calculated: string;
      transactions: number;
      ledger: number;
      outbox: number;
      inbox: number;
    }>
  >(
    `
    SELECT balance::text, version::text,
      (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
        ::numeric(20,2)::text FROM wallet_ledger_entries WHERE wallet_id = w.id) AS calculated,
      (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = w.id) AS transactions,
      (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger,
      (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = w.id) AS outbox,
      (SELECT count(*)::int FROM inbox_messages WHERE message_id = ?) AS inbox
    FROM wallets w WHERE id = ?
  `,
    [messageId, walletId],
  );
  return row;
}

export async function withInsertFailure(
  orm: MikroORM,
  table: 'outbox_messages' | 'wallet_ledger_entries' | 'inbox_messages',
  id: string,
  callback: () => Promise<void>,
) {
  const name = `inject_${randomUUID().replaceAll('-', '')}`;
  const column =
    table === 'outbox_messages'
      ? 'aggregate_id'
      : table === 'inbox_messages'
        ? 'message_id'
        : 'wallet_id';
  const operation = table === 'inbox_messages' ? 'UPDATE' : 'INSERT';
  const predicate =
    table === 'outbox_messages'
      ? `(NEW.aggregate_id::text = '${id}' OR NEW.payload #>> '{data,playerId}' = '${id}')`
      : `NEW.${column}::text = '${id}'`;
  const db = orm.em.fork();
  await db.execute(`CREATE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN IF ${predicate} THEN RAISE EXCEPTION 'INJECTED_${table}_FAILURE'; END IF;
    RETURN NEW; END; $$ LANGUAGE plpgsql`);
  try {
    await db.execute(
      `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      await callback();
    } finally {
      await db.execute(`DROP TRIGGER ${name} ON ${table}`);
    }
  } finally {
    await db.execute(`DROP FUNCTION ${name}()`);
  }
}
