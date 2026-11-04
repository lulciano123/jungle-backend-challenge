
import { Module } from '@nestjs/common';
import { WalletsService } from '../application/services/wallets.service.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
