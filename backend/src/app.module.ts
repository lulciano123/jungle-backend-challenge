import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { HealthController } from './health.controller.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WalletsModule } from './api/wallets.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      driver: PostgreSqlDriver,

      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        host: config.getOrThrow<string>('DB_HOST'),
        port: Number(config.getOrThrow<string>('DB_PORT')),
        dbName: config.getOrThrow<string>('DB_NAME'),
        user: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASSWORD'),

        metadataProvider: ReflectMetadataProvider,
        autoLoadEntities: true,

        // Temporário: ainda não criamos entidades ORM.
        discovery: {
          warnWhenNoEntities: false,
        },
      }),
    }),

    // Registra os endpoints e o serviço de carteiras.
    WalletsModule,
  ],

  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
