import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import {
  NormalizedBankRecord,
  NormalizedLedgerRecord,
} from '../../common/interfaces/normalized-record.interface';

export interface CsvColumnMapping {
  date: string;
  amount: string;
  description: string;
  documentNumber?: string;
  accountCode?: string;
  delimiter?: string;
  dateFormat?: 'DD/MM/YYYY' | 'YYYY-MM-DD';
}

/**
 * Parser CSV genérico. Como cada empresa exporta o razão do Protheus com
 * colunas diferentes, o mapeamento de colunas é configurável em vez de fixo
 * — assim o mesmo parser serve pra extrato bancário em CSV e pra exportação
 * de ERP, sem precisar de dois parsers separados.
 */
@Injectable()
export class CsvParserService {
  supports(fileName: string): boolean {
    return fileName.toLowerCase().endsWith('.csv');
  }

  parseBankCsv(fileBuffer: Buffer, mapping: CsvColumnMapping): NormalizedBankRecord[] {
    const rows = this.parseRows(fileBuffer, mapping);
    return rows.map((row) => ({
      date: this.parseDate(row[mapping.date], mapping.dateFormat),
      amount: this.parseAmount(row[mapping.amount]),
      rawDescription: (row[mapping.description] || '').trim(),
    }));
  }

  parseLedgerCsv(fileBuffer: Buffer, mapping: CsvColumnMapping): NormalizedLedgerRecord[] {
    const rows = this.parseRows(fileBuffer, mapping);
    return rows.map((row) => ({
      date: this.parseDate(row[mapping.date], mapping.dateFormat),
      amount: this.parseAmount(row[mapping.amount]),
      historico: (row[mapping.description] || '').trim(),
      documentNumber: mapping.documentNumber ? row[mapping.documentNumber] : undefined,
      accountCode: mapping.accountCode ? row[mapping.accountCode] : undefined,
    }));
  }

  private parseRows(fileBuffer: Buffer, mapping: CsvColumnMapping): Record<string, string>[] {
    return parse(fileBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: mapping.delimiter || ',',
    });
  }

  private parseDate(value: string, format: CsvColumnMapping['dateFormat'] = 'DD/MM/YYYY'): Date {
    if (format === 'YYYY-MM-DD') {
      return new Date(value);
    }
    const [day, month, year] = value.split('/').map(Number);
    return new Date(year, month - 1, day);
  }

  private parseAmount(value: string): number {
    // Protheus/BR costuma usar "1.234,56" -> precisa normalizar pra 1234.56
    const normalized = value.replace(/\./g, '').replace(',', '.');
    return parseFloat(normalized);
  }
}
