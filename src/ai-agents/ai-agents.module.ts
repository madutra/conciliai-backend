import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { OrchestratorService } from './orchestrator.service';
import { InvestigatorAgentService } from './agents/investigator-agent.service';
import { ParserAgentService } from './agents/parser-agent.service';
import { AnthropicClientService } from './anthropic-client.service';

@Module({
  imports: [ReconciliationModule],
  providers: [OrchestratorService, InvestigatorAgentService, ParserAgentService, AnthropicClientService],
  exports: [OrchestratorService, ParserAgentService],
})
export class AiAgentsModule {}
