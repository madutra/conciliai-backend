import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingEngineService } from '../reconciliation/matching-engine.service';
import { InvestigatorAgentService } from './agents/investigator-agent.service';

/**
 * Orchestrator: é o "cérebro" do pipeline de conciliação.
 *
 * Filosofia (importante pra apresentação): IA não é o primeiro recurso, é o
 * último. O orchestrator só aciona o Investigator Agent para o que sobrou
 * depois do motor determinístico — isso reduz custo de tokens, latência, e
 * torna o sistema auditável (todo match "óbvio" tem uma regra explicável,
 * só o que é genuinamente ambíguo passa por LLM).
 *
 * Pipeline:
 *   1. runDeterministicMatching (regras)
 *   2. investigateBatch (IA, só nos órfãos)
 *   3. marca batch como MATCHED/REVIEWED
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matchingEngine: MatchingEngineService,
    private readonly investigatorAgent: InvestigatorAgentService,
  ) {}

  async runFullReconciliation(batchId: string) {
    await this.prisma.reconciliationBatch.update({
      where: { id: batchId },
      data: { status: 'PROCESSING' },
    });

    const matchingStats = await this.matchingEngine.runDeterministicMatching(batchId);
    this.logger.log(`[Orchestrator] Matching determinístico concluído: ${JSON.stringify(matchingStats)}`);

    const investigationStats = await this.investigatorAgent.investigateBatch(batchId);
    this.logger.log(`[Orchestrator] Investigator Agent concluído: ${JSON.stringify(investigationStats)}`);

    await this.prisma.reconciliationBatch.update({
      where: { id: batchId },
      data: { status: 'MATCHED' },
    });

    return {
      matching: matchingStats,
      investigation: investigationStats,
    };
  }
}
