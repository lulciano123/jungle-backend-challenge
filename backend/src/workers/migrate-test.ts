import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../mikro-orm.config.js';

if (process.env.DB_NAME !== 'jungle_wagering_test') {
  throw new Error('This command only migrates jungle_wagering_test');
}
const orm = await MikroORM.init({
  ...ormConfig,
  dbName: 'jungle_wagering_test',
  migrations: { ...ormConfig.migrations, snapshotOnMigrate: false },
});
try {
  await orm.migrator.up();
} finally {
  await orm.close();
}
