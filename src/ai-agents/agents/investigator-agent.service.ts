import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicClientService } from '../anthropic-client.service';
import { DivergenceType, MatchLeg } from '@prisma/client';

interface InvestigatorOutput {
  provavel_causa:
    | 'TARIFA_NAO_LANCADA'
    | 'ENCARGO_FINANCEIRO_NAO_LANCADO'
    | 'LANCAMENTO_DUPLICADO'
    | 'ERRO_DE_VALOR'
    | 'LANCAMENTO_PENDENTE'
    | 'SALDO_CONTA_GARANTIDA'
    | 'ESTORNO'
    | 'INDETERMINADO';
  explicacao: string;
  conta_contabil_sugerida?: string;
  confianca: number; // 0 a 1
  possivel_par_id?: string; // id de um lançamento do outro lado que pode ser o par
}

// Registro órfão já achatado pro prompt, independente da ponta de origem
interface OrphanRecord {
  id: string;
  date: Date;
  amount: number;
  description: string;
}

const LEG_LABEL: Record<MatchLeg, string> = {
  BANK_VS_FINANCIAL: 'extrato do banco vs extrato do financeiro',
  FINANCIAL_VS_LEDGER: 'extrato do financeiro vs razão contábil',
  BANK_VS_LEDGER: 'extrato do banco vs razão contábil',
};

/**
 * Investigator Agent: entra SÓ para o que sobrou sem match determinístico,
 * perna a perna. Recebe a transação órfã + "quase candidatos" do outro lado
 * e o contexto da conta (natureza, empresa) para classificar a divergência.
 */
@Injectable()
export class InvestigatorAgentService {
  private readonly logger = new Logger(InvestigatorAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicClientService,
  ) {}

  async investigateBatch(batchId: string) {
    const batch = await this.prisma.reconciliationBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { bankAccount: true },
    });
    const isLiability = batch.bankAccount.nature === 'LIABILITY';
    const hasFinancial = (await this.prisma.financialEntry.count({ where: { batchId } })) > 0;

    let investigated = 0;

    if (hasFinancial) {
      // Perna A: banco vs financeiro
      const bankOrphans = await this.loadBankOrphans(batchId);
      const finOrphansVsBank = await this.loadFinancialOrphans(batchId, 'statusVsBank');
      for (const record of bankOrphans) {
        await this.investigateOne(batchId, MatchLeg.BANK_VS_FINANCIAL, 'MISSING_IN_FINANCIAL', 'bank', record, finOrphansVsBank, isLiability);
        investigated++;
      }
      for (const record of finOrphansVsBank) {
        await this.investigateOne(batchId, MatchLeg.BANK_VS_FINANCIAL, 'MISSING_IN_BANK', 'financial', record, bankOrphans, isLiability);
        investigated++;
      }

      // Perna B: financeiro vs razão
      const finOrphansVsLedger = await this.loadFinancialOrphans(batchId, 'statusVsLedger');
      const ledgerOrphans = await this.loadLedgerOrphans(batchId);
      for (const record of finOrphansVsLedger) {
        await this.investigateOne(batchId, MatchLeg.FINANCIAL_VS_LEDGER, 'MISSING_IN_LEDGER', 'financial', record, ledgerOrphans, isLiability);
        investigated++;
      }
      for (const record of ledgerOrphans) {
        await this.investigateOne(batchId, MatchLeg.FINANCIAL_VS_LEDGER, 'MISSING_IN_FINANCIAL', 'ledger', record, finOrphansVsLedger, isLiability);
        investigated++;
      }
    } else {
      // Modo 2 pontas (sem arquivo do financeiro)
      const bankOrphans = await this.loadBankOrphans(batchId);
      const ledgerOrphans = await this.loadLedgerOrphans(batchId);
      for (const record of bankOrphans) {
        await this.investigateOne(batchId, MatchLeg.BANK_VS_LEDGER, 'MISSING_IN_LEDGER', 'bank', record, ledgerOrphans, isLiability);
        investigated++;
      }
      for (const record of ledgerOrphans) {
        await this.investigateOne(batchId, MatchLeg.BANK_VS_LEDGER, 'MISSING_IN_BANK', 'ledger', record, bankOrphans, isLiability);
        investigated++;
      }
    }

    return { investigated };
  }

  private async loadBankOrphans(batchId: string): Promise<(OrphanRecord & { kind: 'bank' })[]> {
    const rows = await this.prisma.bankTransaction.findMany({ where: { batchId, status: 'UNMATCHED' } });
    return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), description: r.rawDescription, kind: 'bank' as const }));
  }

  private async loadLedgerOrphans(batchId: string): Promise<(OrphanRecord & { kind: 'ledger' })[]> {
    const rows = await this.prisma.ledgerEntry.findMany({ where: { batchId, status: 'UNMATCHED' } });
    return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), description: r.historico, kind: 'ledger' as const }));
  }

  private async loadFinancialOrphans(
    batchId: string,
    statusField: 'statusVsBank' | 'statusVsLedger',
  ): Promise<(OrphanRecord & { kind: 'financial' })[]> {
    const rows = await this.prisma.financialEntry.findMany({ where: { batchId, [statusField]: 'UNMATCHED' } });
    return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), description: r.description, kind: 'financial' as const }));
  }

  private async investigateOne(
    batchId: string,
    leg: MatchLeg,
    type: DivergenceType,
    recordKind: 'bank' | 'financial' | 'ledger',
    record: OrphanRecord,
    candidatesOtherSide: OrphanRecord[],
    isLiability: boolean,
  ) {
    // Candidatos "quase": mesmo valor com folga maior, pra dar contexto ao modelo.
    const nearCandidates = candidatesOtherSide
      .filter((c) => Math.abs(Math.abs(c.amount) - Math.abs(record.amount)) < Math.abs(record.amount) * 0.15 + 1)
      .slice(0, 5)
      .map((c) => ({
        id: c.id,
        date: c.date.toISOString().slice(0, 10),
        amount: c.amount,
        description: c.description,
      }));

    const prompt = `
Perna da conciliação: ${LEG_LABEL[leg]}.
Lançamento sem correspondência (${this.orphanContext(type)}):
- Data: ${record.date.toISOString().slice(0, 10)}
- Valor: ${record.amount}
- Descrição: "${record.description}"

Candidatos próximos do outro lado (não bateram no match automático):
${nearCandidates.length ? JSON.stringify(nearCandidates, null, 2) : 'Nenhum candidato próximo encontrado.'}

Analise e classifique a divergência.
`.trim();

    const system =
      'Você é um agente auxiliar de um analista contábil brasileiro, especializado em conciliação bancária de 3 pontas ' +
      '(extrato do banco, extrato do financeiro/SIGAFIN e razão contábil do Protheus). ' +
      (isLiability
        ? 'A conta é uma CONTA GARANTIDA (passivo, saldo devedor é normal). Nesse contexto: tarifas bancárias, IOF e ' +
          'encargos da conta garantida costumam existir só no extrato do banco até o financeiro lançar — causa provável ' +
          'TARIFA_NAO_LANCADA ou ENCARGO_FINANCEIRO_NAO_LANCADO, não erro. Lançamentos de abertura/fechamento como ' +
          '"TRANSF CONTA GARANTIDA" ou "EMPRESTIMO CONTA GARANTIDA" no razão são a contrapartida do saldo do mês ' +
          '(causa SALDO_CONTA_GARANTIDA), esperados e sem par no banco. '
        : '') +
      'Seja objetivo e conservador: só sugira uma causa com confiança alta se a evidência for clara. ' +
      'Use os candidatos apenas como pista — não afirme um par se a descrição e o valor não forem plausíveis.';

    try {
      const { result, tokensUsed, durationMs } = await this.anthropic.structuredCompletion<InvestigatorOutput>({
        system,
        prompt,
        toolName: 'classificar_divergencia',
        toolDescription: 'Classifica a causa provável de uma divergência de conciliação bancária',
        inputSchema: {
          type: 'object',
          properties: {
            provavel_causa: {
              type: 'string',
              enum: [
                'TARIFA_NAO_LANCADA',
                'ENCARGO_FINANCEIRO_NAO_LANCADO',
                'LANCAMENTO_DUPLICADO',
                'ERRO_DE_VALOR',
                'LANCAMENTO_PENDENTE',
                'SALDO_CONTA_GARANTIDA',
                'ESTORNO',
                'INDETERMINADO',
              ],
            },
            explicacao: { type: 'string', description: 'Explicação curta em português para o analista' },
            conta_contabil_sugerida: { type: 'string' },
            confianca: { type: 'number', minimum: 0, maximum: 1 },
            possivel_par_id: { type: 'string', description: 'id de um candidato, se houver par plausível' },
          },
          required: ['provavel_causa', 'explicacao', 'confianca'],
        },
      });

      await this.prisma.divergence.create({
        data: {
          batchId,
          leg,
          type,
          ...this.recordRef(recordKind, record.id),
          aiExplanation: result.explicacao,
          suggestedCause: result.provavel_causa?.slice(0, 255),
          // o modelo às vezes devolve descrição junto do código — trunca no limite da coluna
          suggestedAccount: result.conta_contabil_sugerida?.slice(0, 50),
          aiConfidence: result.confianca,
        },
      });

      await this.prisma.agentRun.create({
        data: {
          batchId,
          agentName: 'investigator-agent',
          input: prompt,
          output: JSON.stringify(result),
          tokensUsed,
          durationMs,
        },
      });
    } catch (err) {
      this.logger.error(`Falha ao investigar registro ${record.id}: ${err}`);
      // Fallback: cria divergência sem enriquecimento de IA, pra não travar o batch
      await this.prisma.divergence.create({
        data: {
          batchId,
          leg,
          type,
          ...this.recordRef(recordKind, record.id),
          suggestedCause: 'INDETERMINADO',
        },
      });
    }
  }

  private recordRef(kind: 'bank' | 'financial' | 'ledger', id: string) {
    if (kind === 'bank') return { bankTransactionId: id };
    if (kind === 'financial') return { financialEntryId: id };
    return { ledgerEntryId: id };
  }

  private orphanContext(type: DivergenceType): string {
    switch (type) {
      case 'MISSING_IN_FINANCIAL':
        return 'não encontrado no extrato do financeiro';
      case 'MISSING_IN_LEDGER':
        return 'não encontrado no razão contábil';
      case 'MISSING_IN_BANK':
        return 'não encontrado no extrato do banco';
      default:
        return 'sem correspondência';
    }
  }
}
