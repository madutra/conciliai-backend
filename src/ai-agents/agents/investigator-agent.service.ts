import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicClientService } from '../anthropic-client.service';
import { BankTransaction, LedgerEntry } from '@prisma/client';

interface InvestigatorOutput {
  provavel_causa:
    | 'TARIFA_NAO_LANCADA'
    | 'LANCAMENTO_DUPLICADO'
    | 'ERRO_DE_VALOR'
    | 'LANCAMENTO_PENDENTE'
    | 'ESTORNO'
    | 'INDETERMINADO';
  explicacao: string;
  conta_contabil_sugerida?: string;
  confianca: number; // 0 a 1
  possivel_par_id?: string; // id de um lançamento do outro lado que pode ser o par (descrição parecida, valor perto)
}

/**
 * Investigator Agent: entra SÓ para o que sobrou sem match determinístico.
 * Recebe a transação órfã + uma lista curta de "quase candidatos" do outro
 * lado (mesmo se o valor não bateu exato) para dar contexto ao modelo.
 */
@Injectable()
export class InvestigatorAgentService {
  private readonly logger = new Logger(InvestigatorAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicClientService,
  ) {}

  async investigateBatch(batchId: string) {
    const unmatchedBank = await this.prisma.bankTransaction.findMany({
      where: { batchId, status: 'UNMATCHED' },
    });
    const unmatchedLedger = await this.prisma.ledgerEntry.findMany({
      where: { batchId, status: 'UNMATCHED' },
    });

    for (const bt of unmatchedBank) {
      await this.investigateOne(batchId, 'MISSING_IN_LEDGER', bt, unmatchedLedger);
    }
    for (const lt of unmatchedLedger) {
      await this.investigateOne(batchId, 'MISSING_IN_BANK', lt, unmatchedBank);
    }

    return { investigated: unmatchedBank.length + unmatchedLedger.length };
  }

  private async investigateOne(
    batchId: string,
    type: 'MISSING_IN_LEDGER' | 'MISSING_IN_BANK',
    record: BankTransaction | LedgerEntry,
    candidatesOtherSide: (BankTransaction | LedgerEntry)[],
  ) {
    const description = 'rawDescription' in record ? record.rawDescription : record.historico;

    // Candidatos "quase": mesmo valor com folga maior, ou descrição parecida.
    const nearCandidates = candidatesOtherSide
      .filter((c) => Math.abs(Number(c.amount) - Number(record.amount)) < Number(record.amount) * 0.15 + 1)
      .slice(0, 5)
      .map((c) => ({
        id: c.id,
        date: c.date.toISOString().slice(0, 10),
        amount: Number(c.amount),
        description: 'rawDescription' in c ? c.rawDescription : c.historico,
      }));

    const prompt = `
Lançamento sem correspondência (${type === 'MISSING_IN_LEDGER' ? 'existe no banco, falta no ERP' : 'existe no ERP, falta no extrato bancário'}):
- Data: ${record.date.toISOString().slice(0, 10)}
- Valor: ${Number(record.amount)}
- Descrição: "${description}"

Candidatos próximos do outro lado (não bateram no match automático):
${nearCandidates.length ? JSON.stringify(nearCandidates, null, 2) : 'Nenhum candidato próximo encontrado.'}

Analise e classifique a divergência.
`.trim();

    try {
      const { result, tokensUsed, durationMs } = await this.anthropic.structuredCompletion<InvestigatorOutput>({
        system:
          'Você é um agente auxiliar de um analista contábil brasileiro, especializado em conciliação bancária. ' +
          'Seja objetivo e conservador: só sugira uma causa com confiança alta se a evidência for clara. ' +
          'Use os candidatos apenas como pista — não afirme um par se a descrição e o valor não forem plausíveis.',
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
                'LANCAMENTO_DUPLICADO',
                'ERRO_DE_VALOR',
                'LANCAMENTO_PENDENTE',
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
          type,
          bankTransactionId: type === 'MISSING_IN_LEDGER' ? record.id : undefined,
          ledgerEntryId: type === 'MISSING_IN_BANK' ? record.id : undefined,
          aiExplanation: result.explicacao,
          suggestedCause: result.provavel_causa,
          suggestedAccount: result.conta_contabil_sugerida,
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
          type,
          bankTransactionId: type === 'MISSING_IN_LEDGER' ? record.id : undefined,
          ledgerEntryId: type === 'MISSING_IN_BANK' ? record.id : undefined,
          suggestedCause: 'INDETERMINADO',
        },
      });
    }
  }
}
