import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { MatchingEngineService } from './matching-engine.service';

@Module({
  controllers: [ReconciliationController],
  providers: [MatchingEngineService],
  exports: [MatchingEngineService],
})
export class ReconciliationModule {}
