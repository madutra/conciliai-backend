import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicClientService } from '../anthropic-client.service';
import { NormalizedBankRecord } from '../../common/interfaces/normalized-record.interface';
import { extractDocTokens } from '../../common/document-number.util';

interface ParsedTransaction {
  date: string; // YYYY-MM-DD
  description: string;
  document?: string;
  amount: number; // negativo = débito
}

/**
 * Parser Agent: terceiro agente da arquitetura. Entra SÓ quando o parser
 * determinístico de PDF falha (layout desconhecido, texto bagunçado).
 * Recebe o texto cru extraído do PDF e devolve lançamentos estruturados
 * via tool_use — mesma técnica do Investigator, mas com max_tokens maior
 * e processamento por página pra não estourar o limite de output.
 */
@Injectable()
export class ParserAgentService {
  private readonly logger = new Logger(ParserAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicClientService,
  ) {}

  async parseBankStatementText(text: string, batchId?: string): Promise<NormalizedBankRecord[]> {
    const chunks = this.splitInChunks(text, 8000);
    const records: NormalizedBankRecord[] = [];

    for (const [i, chunk] of chunks.entries()) {
      this.logger.log(`Parser Agent: processando trecho ${i + 1}/${chunks.length}`);
      const prompt = `
Texto extraído de um extrato bancário brasileiro em PDF (trecho ${i + 1} de ${chunks.length}):

<extrato>
${chunk}
</extrato>

Extraia TODOS os lançamentos (transações) deste trecho. Regras:
- Valores de débito são negativos, crédito positivos (formato brasileiro "1.234,56" vira 1234.56).
- Ignore linhas de saldo (SALDO ANTERIOR, saldo do dia), totais, cabeçalhos e rodapés.
- Ignore seções fora do período principal (ex.: "Últimos Lançamentos").
- A descrição pode ocupar mais de uma linha — junte em uma só.
- Se houver número de documento (Dcto.), inclua no campo document.
`.trim();

      try {
        const { result, tokensUsed, durationMs } = await this.anthropic.structuredCompletion<{
          transactions: ParsedTransaction[];
        }>({
          system:
            'Você é um parser de extratos bancários brasileiros. Extraia lançamentos com precisão absoluta ' +
            'de valores e datas. Nunca invente lançamentos: se um valor estiver ilegível, omita a linha.',
          prompt,
          toolName: 'registrar_lancamentos',
          toolDescription: 'Registra os lançamentos bancários extraídos do texto',
          inputSchema: {
            type: 'object',
            properties: {
              transactions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
                    description: { type: 'string' },
                    document: { type: 'string' },
                    amount: { type: 'number', description: 'Negativo para débito' },
                  },
                  required: ['date', 'description', 'amount'],
                },
              },
            },
            required: ['transactions'],
          },
          maxTokens: 8192,
        });

        for (const tx of result.transactions ?? []) {
          const date = new Date(`${tx.date}T00:00:00`);
          if (Number.isNaN(date.getTime())) continue;
          records.push({
            date,
            amount: tx.amount,
            rawDescription: tx.description.slice(0, 500),
            documentNumber: extractDocTokens(tx.document, tx.description),
          });
        }

        if (batchId) {
          await this.prisma.agentRun.create({
            data: {
              batchId,
              agentName: 'parser-agent',
              input: `[trecho ${i + 1}/${chunks.length}] ${chunk.slice(0, 2000)}`,
              output: JSON.stringify({ extracted: result.transactions?.length ?? 0 }),
              tokensUsed,
              durationMs,
            },
          });
        }
      } catch (err) {
        this.logger.error(`Parser Agent falhou no trecho ${i + 1}: ${err}`);
      }
    }

    return records;
  }

  // Quebra por linha, respeitando o tamanho máximo por trecho — uma
  // transação nunca é cortada no meio porque o corte é em quebra de linha.
  private splitInChunks(text: string, maxChars: number): string[] {
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current: string[] = [];
    let size = 0;

    for (const line of lines) {
      if (size + line.length > maxChars && current.length) {
        chunks.push(current.join('\n'));
        current = [];
        size = 0;
      }
      current.push(line);
      size += line.length + 1;
    }
    if (current.length) chunks.push(current.join('\n'));
    return chunks;
  }
}
