import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { OrchestratorService } from './orchestrator.service';
import { InvestigatorAgentService } from './agents/investigator-agent.service';
import { AnthropicClientService } from './anthropic-client.service';

@Module({
  imports: [ReconciliationModule],
  providers: [OrchestratorService, InvestigatorAgentService, AnthropicClientService],
  exports: [OrchestratorService],
})
export class AiAgentsModule {}
