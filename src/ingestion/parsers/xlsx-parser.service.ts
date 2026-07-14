import { Injectable, BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import {
  NormalizedFinancialRecord,
  NormalizedLedgerRecord,
} from '../../common/interfaces/normalized-record.interface';
import { extractDocTokens } from '../../common/document-number.util';

type Cell = string | number | Date | null | undefined;
type Row = Cell[];

/**
 * Parser determinístico para os XLSX exportados do Protheus:
 *   - Extrato do FINANCEIRO (SIGAFIN): colunas DATA / OPERAÇÃO / DOCUMENTO /
 *     ENTRADAS / SAIDAS / SALDO ATUAL → amount = entradas - saidas.
 *   - Razão contábil (Emissão do Razão): colunas DATA / HISTORICO / DEBITO /
 *     CREDITO → amount = debito - credito. Isso vale tanto pra conta ativa
 *     quanto pra conta garantida (passiva): no razão da própria conta,
 *     entrada de dinheiro é sempre débito — então o sinal já sai na
 *     convenção do extrato bancário, sem precisar inverter.
 *
 * Os relatórios usam células mescladas, então o rótulo do cabeçalho pode
 * estar algumas colunas antes do dado. A localização é feita por rótulo com
 * tolerância de offset, não por índice fixo.
 */
@Injectable()
export class XlsxParserService {
  supports(fileName: string): boolean {
    return /\.xlsx?$/i.test(fileName.toLowerCase());
  }

  parseFinancialXlsx(fileBuffer: Buffer): NormalizedFinancialRecord[] {
    const rows = this.readRows(fileBuffer);
    const header = this.findHeaderRow(rows, ['DATA', 'ENTRADAS', 'SAIDAS']);
    if (!header) {
      throw new BadRequestException(
        'Layout não reconhecido: esperava extrato do financeiro (SIGAFIN) com colunas DATA/ENTRADAS/SAIDAS',
      );
    }

    const col = {
      date: this.findColumn(header.row, 'DATA'),
      operation: this.findColumn(header.row, 'OPERA'),
      document: this.findColumn(header.row, 'DOCUMENTO'),
      in: this.findColumn(header.row, 'ENTRADAS'),
      out: this.findColumn(header.row, 'SAIDAS'),
    };

    const records: NormalizedFinancialRecord[] = [];
    for (const row of rows.slice(header.index + 1)) {
      const date = this.parseDate(this.pick(row, col.date));
      if (!date) continue;

      const entradas = this.parseNumber(this.pick(row, col.in));
      const saidas = this.parseNumber(this.pick(row, col.out));
      if (entradas === null && saidas === null) continue;

      const operation = String(this.pick(row, col.operation) ?? '').trim();
      const document = String(this.pick(row, col.document) ?? '').trim();

      records.push({
        date,
        amount: this.round2((entradas ?? 0) - (saidas ?? 0)),
        description: [operation, document].filter(Boolean).join(' | '),
        documentNumber: extractDocTokens(document, operation),
      });
    }
    return records;
  }

  parseLedgerXlsx(fileBuffer: Buffer): NormalizedLedgerRecord[] {
    const rows = this.readRows(fileBuffer);
    const header = this.findHeaderRow(rows, ['DATA', 'DEBITO', 'CREDITO']);
    if (!header) {
      throw new BadRequestException(
        'Layout não reconhecido: esperava razão do Protheus com colunas DATA/HISTORICO/DEBITO/CREDITO',
      );
    }

    const col = {
      date: this.findColumn(header.row, 'DATA'),
      lote: this.findColumn(header.row, 'LOTE'),
      historico: this.findColumn(header.row, 'HISTORICO'),
      contraPartida: this.findColumn(header.row, 'C/PARTIDA'),
      debito: this.findColumn(header.row, 'DEBITO'),
      credito: this.findColumn(header.row, 'CREDITO'),
    };

    const records: NormalizedLedgerRecord[] = [];
    for (const row of rows.slice(header.index + 1)) {
      const date = this.parseDate(this.pick(row, col.date));
      if (!date) continue;

      const debito = this.parseNumber(this.pick(row, col.debito));
      const credito = this.parseNumber(this.pick(row, col.credito));
      if (debito === null && credito === null) continue;

      const historico = String(this.pick(row, col.historico) ?? '').trim();
      const lote = String(this.pick(row, col.lote) ?? '').trim();

      records.push({
        date,
        amount: this.round2((debito ?? 0) - (credito ?? 0)),
        historico,
        documentNumber: extractDocTokens(historico),
        accountCode: String(this.pick(row, col.contraPartida) ?? '').trim() || undefined,
        loteDocLinha: lote || undefined,
      });
    }
    return records;
  }

  private readRows(fileBuffer: Buffer): Row[] {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, raw: true, defval: null });
  }

  // Cabeçalho = primeira linha que contém todos os rótulos esperados
  private findHeaderRow(rows: Row[], labels: string[]): { index: number; row: Row } | null {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const cells = rows[i].map((c) => this.normalizeLabel(c));
      if (labels.every((label) => cells.some((c) => c.startsWith(label)))) {
        return { index: i, row: rows[i] };
      }
    }
    return null;
  }

  private findColumn(headerRow: Row, label: string): number {
    return headerRow.findIndex((c) => this.normalizeLabel(c).startsWith(label));
  }

  // Células mescladas deslocam o dado pra direita do rótulo: procura o
  // primeiro valor não-nulo numa janela curta a partir da coluna do rótulo.
  private pick(row: Row, colIndex: number): Cell {
    if (colIndex < 0) return null;
    for (let offset = 0; offset <= 3; offset++) {
      const value = row[colIndex + offset];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }

  private normalizeLabel(cell: Cell): string {
    return String(cell ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toUpperCase();
  }

  private parseDate(value: Cell): Date | null {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    if (typeof value === 'string') {
      const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    }
    return null;
  }

  private parseNumber(value: Cell): number | null {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.replace(/\./g, '').replace(',', '.');
      const parsed = parseFloat(normalized);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
