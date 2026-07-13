import { Module } from '@nestjs/common';
import { BatchesController } from './batches.controller';
import { AiAgentsModule } from '../ai-agents/ai-agents.module';

@Module({
  imports: [AiAgentsModule],
  controllers: [BatchesController],
})
export class BatchesModule {}
