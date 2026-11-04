
import { Module } from '@nestjs/common';
import { BettingService } from '../application/services/betting.service.js';
import { WageringController } from './wagering.controller.js';

@Module({
  controllers: [WageringController],
  providers: [BettingService],
  exports: [BettingService],
})
export class WageringModule {}
