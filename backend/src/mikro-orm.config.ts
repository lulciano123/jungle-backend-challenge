import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}`,
    );
  }

  return value;
}

export default defineConfig({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? '5433'),
  user: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASSWORD'),
  dbName: requiredEnv('DB_NAME'),

  metadataProvider: ReflectMetadataProvider,

  // Ainda não criamos os modelos de persistência.
  entities: [],
  discovery: {
    warnWhenNoEntities: false,
  },

  extensions: [Migrator],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
  },
});
