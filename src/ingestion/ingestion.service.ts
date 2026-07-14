import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OfxParserService } from './parsers/ofx-parser.service';
import { CsvParserService, CsvColumnMapping } from './parsers/csv-parser.service';
import { XlsxParserService } from './parsers/xlsx-parser.service';
import { PdfParserService } from './parsers/pdf-parser.service';
import {
  NormalizedBankRecord,
  NormalizedFinancialRecord,
  NormalizedLedgerRecord,
} from '../common/interfaces/normalized-record.interface';
import { extractDocTokens } from '../common/document-number.util';

// Mapeamento default pro MVP. No próximo incremento isso vira configurável
// pelo usuário na tela de upload (cada empresa exporta o Protheus diferente).
const DEFAULT_BANK_CSV_MAPPING: CsvColumnMapping = {
  date: 'data',
  amount: 'valor',
  description: 'descricao',
  dateFormat: 'DD/MM/YYYY',
};

const DEFAULT_LEDGER_CSV_MAPPING: CsvColumnMapping = {
  date: 'data',
  amount: 'valor',
  description: 'historico',
  documentNumber: 'documento',
  accountCode: 'conta',
  dateFormat: 'DD/MM/YYYY',
};

/**
 * Ingestão das 3 pontas da conciliação:
 *   banco      → OFX, CSV ou PDF (extrato oficial do banco)
 *   financeiro → XLSX do SIGAFIN (extrato gerado pelo financeiro)
 *   razão      → XLSX do Protheus ou CSV
 * Todo arquivo é normalizado pro mesmo contrato (Normalized*Record) antes
 * de persistir — o resto do pipeline não sabe de onde o dado veio.
 */
@Injectable()
export class IngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ofxParser: OfxParserService,
    private readonly csvParser: CsvParserService,
    private readonly xlsxParser: XlsxParserService,
    private readonly pdfParser: PdfParserService,
  ) {}

  async ingestBankFile(batchId: string, file: Express.Multer.File) {
    let records: NormalizedBankRecord[];
    if (this.pdfParser.supports(file.originalname)) {
      records = await this.pdfParser.parse(file.buffer, batchId);
    } else if (this.ofxParser.supports(file.originalname)) {
      records = await this.ofxParser.parse(file.buffer);
    } else if (this.csvParser.supports(file.originalname)) {
      records = this.csvParser.parseBankCsv(file.buffer, DEFAULT_BANK_CSV_MAPPING);
    } else {
      this.throwUnsupported(file.originalname);
    }

    await this.prisma.bankTransaction.deleteMany({ where: { batchId } });
    await this.prisma.bankTransaction.createMany({
      data: records.map((r) => ({
        batchId,
        date: r.date,
        amount: r.amount,
        rawDescription: r.rawDescription,
        fitId: r.fitId,
        documentNumber: r.documentNumber ?? extractDocTokens(r.rawDescription),
      })),
    });

    await this.prisma.reconciliationBatch.update({
      where: { id: batchId },
      data: { bankFileName: file.originalname },
    });

    return { imported: records.length, source: 'bank' };
  }

  async ingestFinancialFile(batchId: string, file: Express.Multer.File) {
    let records: NormalizedFinancialRecord[];
    if (this.xlsxParser.supports(file.originalname)) {
      records = this.xlsxParser.parseFinancialXlsx(file.buffer);
    } else if (this.csvParser.supports(file.originalname)) {
      records = this.csvParser.parseBankCsv(file.buffer, DEFAULT_BANK_CSV_MAPPING).map((r) => ({
        date: r.date,
        amount: r.amount,
        description: r.rawDescription,
        documentNumber: extractDocTokens(r.rawDescription),
      }));
    } else {
      this.throwUnsupported(file.originalname);
    }

    await this.prisma.financialEntry.deleteMany({ where: { batchId } });
    await this.prisma.financialEntry.createMany({
      data: records.map((r) => ({
        batchId,
        date: r.date,
        amount: r.amount,
        description: r.description,
        documentNumber: r.documentNumber,
      })),
    });

    await this.prisma.reconciliationBatch.update({
      where: { id: batchId },
      data: { financialFileName: file.originalname },
    });

    return { imported: records.length, source: 'financial' };
  }

  async ingestLedgerFile(batchId: string, file: Express.Multer.File) {
    let records: NormalizedLedgerRecord[];
    if (this.xlsxParser.supports(file.originalname)) {
      records = this.xlsxParser.parseLedgerXlsx(file.buffer);
    } else if (this.csvParser.supports(file.originalname)) {
      records = this.csvParser.parseLedgerCsv(file.buffer, DEFAULT_LEDGER_CSV_MAPPING);
    } else {
      this.throwUnsupported(file.originalname);
    }

    await this.prisma.ledgerEntry.deleteMany({ where: { batchId } });
    await this.prisma.ledgerEntry.createMany({
      data: records.map((r) => ({
        batchId,
        date: r.date,
        amount: r.amount,
        historico: r.historico,
        documentNumber: r.documentNumber ?? extractDocTokens(r.historico),
        accountCode: r.accountCode,
        loteDocLinha: r.loteDocLinha,
      })),
    });

    await this.prisma.reconciliationBatch.update({
      where: { id: batchId },
      data: { ledgerFileName: file.originalname },
    });

    return { imported: records.length, source: 'ledger' };
  }

  private throwUnsupported(fileName: string): never {
    throw new BadRequestException(`Formato de arquivo não suportado: ${fileName}`);
  }
}
