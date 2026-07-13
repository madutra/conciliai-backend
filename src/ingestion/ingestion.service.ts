import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OfxParserService } from './parsers/ofx-parser.service';
import { CsvParserService, CsvColumnMapping } from './parsers/csv-parser.service';

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

@Injectable()
export class IngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ofxParser: OfxParserService,
    private readonly csvParser: CsvParserService,
  ) {}

  async ingestBankFile(batchId: string, file: Express.Multer.File) {
    const records = this.ofxParser.supports(file.originalname)
      ? await this.ofxParser.parse(file.buffer)
      : this.csvParser.supports(file.originalname)
        ? this.csvParser.parseBankCsv(file.buffer, DEFAULT_BANK_CSV_MAPPING)
        : this.throwUnsupported(file.originalname);

    await this.prisma.bankTransaction.createMany({
      data: records.map((r) => ({
        batchId,
        date: r.date,
        amount: r.amount,
        rawDescription: r.rawDescription,
        fitId: r.fitId,
      })),
    });

    await this.prisma.reconciliationBatch.update({
      where: { id: batchId },
      data: { bankFileName: file.originalname },
    });

    return { imported: records.length, source: 'bank' };
  }

  async ingestLedgerFile(batchId: string, file: Express.Multer.File) {
    if (!this.csvParser.supports(file.originalname)) {
      this.throwUnsupported(file.originalname);
    }

    const records = this.csvParser.parseLedgerCsv(file.buffer, DEFAULT_LEDGER_CSV_MAPPING);

    await this.prisma.ledgerEntry.createMany({
      data: records.map((r) => ({
        batchId,
        date: r.date,
        amount: r.amount,
        historico: r.historico,
        documentNumber: r.documentNumber,
        accountCode: r.accountCode,
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
