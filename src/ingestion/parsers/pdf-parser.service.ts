import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { NormalizedBankRecord } from '../../common/interfaces/normalized-record.interface';
import { extractDocTokens } from '../../common/document-number.util';
import { ParserAgentService } from '../../ai-agents/agents/parser-agent.service';
// pdf-parse exporta função CommonJS; import default quebra no build do Nest
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');

/**
 * Parser de extrato bancário em PDF (layout Bradesco "Extrato Consolidado").
 *
 * Segue a filosofia do projeto: determinístico primeiro, IA por último.
 *
 * O texto extraído do PDF vem com as colunas COLADAS, sem separador:
 *   "900188124.638,16-1.970.906,79"  →  dcto=9001881, valor=24.638,16, saldo=-1.970.906,79
 * A fronteira entre os números é ambígua por regex pura. A saída é usar uma
 * propriedade do próprio extrato: toda linha carrega o SALDO resultante, e
 * valor = saldo_atual - saldo_anterior. Então o parser:
 *   1. enumera os possíveis "saldos" no fim da linha;
 *   2. escolhe o candidato cujo delta contra o saldo anterior aparece
 *      formatado imediatamente antes dele na linha (prova dupla);
 *   3. o que sobra no início é o número do documento.
 * Cada lançamento sai validado pela cadeia de saldos. Se a taxa de validação
 * ficar baixa (layout desconhecido, PDF escaneado), cai pro Parser Agent (IA).
 */
@Injectable()
export class PdfParserService {
  private readonly logger = new Logger(PdfParserService.name);

  private static readonly MIN_VALIDATION_RATE = 0.9;

  constructor(private readonly parserAgent: ParserAgentService) {}

  supports(fileName: string): boolean {
    return fileName.toLowerCase().endsWith('.pdf');
  }

  async parse(fileBuffer: Buffer, batchId?: string): Promise<NormalizedBankRecord[]> {
    const { text } = await pdfParse(fileBuffer);

    const deterministic = this.parseDeterministic(text);
    if (deterministic) {
      this.logger.log(
        `PDF parseado deterministicamente: ${deterministic.length} lançamentos validados por saldo`,
      );
      return deterministic;
    }

    this.logger.warn('Parser determinístico não validou o PDF — acionando Parser Agent (IA)');
    const viaAgent = await this.parserAgent.parseBankStatementText(text, batchId);
    if (!viaAgent.length) {
      throw new BadRequestException('Não foi possível extrair lançamentos do PDF');
    }
    return viaAgent;
  }

  private parseDeterministic(text: string): NormalizedBankRecord[] | null {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const records: NormalizedBankRecord[] = [];
    let currentDate: Date | null = null;
    let previousBalance: number | null = null;
    let descriptionBuffer: string[] = [];
    let validated = 0;

    for (const line of lines) {
      // O extrato do período termina no "Total"; depois vêm "Últimos
      // Lançamentos" (outro período) e rodapés — nada disso entra.
      if (/^Total-?\d|^Total\s/.test(line) || /^[ÚU]ltimos Lan[çc]amentos/i.test(line)) break;
      if (this.isNoise(line)) continue;

      // Data em linha própria define o dia dos lançamentos seguintes
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(line)) {
        currentDate = this.parseBrDate(line);
        continue;
      }

      const balanceCandidates = this.trailingMoneyCandidates(line);
      if (!balanceCandidates.length) {
        descriptionBuffer.push(line);
        continue;
      }

      // Linha de abertura: buffer contém "SALDO ANTERIOR", linha é só o saldo
      if (descriptionBuffer.some((l) => /SALDO ANTERIOR/i.test(l))) {
        previousBalance = balanceCandidates[0].value;
        descriptionBuffer = [];
        continue;
      }

      const parsed = this.resolveAmountLine(line, balanceCandidates, previousBalance);
      if (!parsed) {
        descriptionBuffer.push(line);
        continue;
      }

      if (parsed.validatedByChain) validated++;
      if (currentDate) {
        const description = [...descriptionBuffer, parsed.documentText]
          .filter(Boolean)
          .join(' ')
          .trim();
        records.push({
          date: currentDate,
          amount: parsed.amount,
          rawDescription: description.slice(0, 500),
          documentNumber: extractDocTokens(description),
        });
      }

      previousBalance = parsed.balance;
      descriptionBuffer = [];
    }

    if (!records.length) return null;
    const validationRate = validated / records.length;
    if (validationRate < PdfParserService.MIN_VALIDATION_RATE) {
      this.logger.warn(
        `Validação por saldo baixa (${(validationRate * 100).toFixed(0)}%) — descartando resultado determinístico`,
      );
      return null;
    }
    return records;
  }

  /**
   * Desambigua uma linha "dcto+valor+saldo" colados. Para cada candidato a
   * saldo no fim da linha, o valor implícito (saldo - saldo anterior) precisa
   * aparecer formatado imediatamente antes — se aparecer, a fronteira está
   * provada e o resto é o documento.
   */
  private resolveAmountLine(
    line: string,
    balanceCandidates: { value: number; start: number }[],
    previousBalance: number | null,
  ): { amount: number; balance: number; documentText: string; validatedByChain: boolean } | null {
    if (previousBalance !== null) {
      for (const candidate of balanceCandidates) {
        const impliedAmount = this.round2(candidate.value - previousBalance);
        if (impliedAmount === 0) continue;
        const head = line.slice(0, candidate.start).trimEnd();
        const formatted = this.formatBrNumber(impliedAmount);
        if (head.endsWith(formatted)) {
          return {
            amount: impliedAmount,
            balance: candidate.value,
            documentText: head.slice(0, head.length - formatted.length).trim(),
            validatedByChain: true,
          };
        }
      }
    }

    // Sem prova dupla: se a linha tem cara de valores (2+ números com
    // centavos) e conhecemos o saldo anterior, recupera o valor por delta
    // usando o candidato mais longo (fronteira mais provável).
    const moneyCount = (line.match(/,\d{2}(?!\d)/g) ?? []).length;
    if (previousBalance !== null && moneyCount >= 2) {
      const candidate = balanceCandidates[balanceCandidates.length - 1];
      return {
        amount: this.round2(candidate.value - previousBalance),
        balance: candidate.value,
        documentText: line.slice(0, candidate.start).trim(),
        validatedByChain: false,
      };
    }

    return null;
  }

  // Todos os sufixos da linha que são um número monetário BR válido,
  // do mais curto ("906,79") ao mais longo ("-1.970.906,79")
  private trailingMoneyCandidates(line: string): { value: number; start: number }[] {
    const candidates: { value: number; start: number }[] = [];
    const MONEY_FULL = /^-?(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}$/;
    const maxLookback = Math.min(line.length, 22); // "-9.999.999.999.999,99"

    for (let len = 4; len <= maxLookback; len++) {
      const start = line.length - len;
      const suffix = line.slice(start);
      if (MONEY_FULL.test(suffix)) {
        candidates.push({ value: this.parseBrNumber(suffix), start });
      }
    }
    // mais longo primeiro: fronteira mais provável quando há ambiguidade
    return candidates.sort((a, b) => a.start - b.start);
  }

  private isNoise(line: string): boolean {
    return (
      /^(Folha ?\d|Extrato Consolidado|Extrato de:|Ag[êe]ncia|Data[A-Zd]|Data d|Nome do usu|Os dados acima|Saldos Invest|N[ãa]o h[áa] lan[çc]amentos|bradesco|net empresa)/i.test(
        line,
      ) ||
      /CNPJ:? ?[\d./-]+$/.test(line) ||
      /^\d{5} \| \d{7}-\d/.test(line) // "03684 | 0001881-3..." do cabeçalho
    );
  }

  private parseBrDate(value: string): Date {
    const [day, month, year] = value.split('/').map(Number);
    return new Date(year, month - 1, day);
  }

  private parseBrNumber(value: string): number {
    return parseFloat(value.replace(/\./g, '').replace(',', '.'));
  }

  private formatBrNumber(value: number): string {
    return new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
