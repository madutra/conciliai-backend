import { Injectable } from '@nestjs/common';
import * as ofx from 'ofx-js';
import { FileParser, NormalizedBankRecord } from '../../common/interfaces/normalized-record.interface';

/**
 * Parser determinístico para arquivos OFX (padrão mais comum de extrato bancário).
 * Não usa IA aqui de propósito: OFX é estruturado, então IA seria caro e
 * menos confiável que um parser dedicado.
 */
@Injectable()
export class OfxParserService implements FileParser<NormalizedBankRecord> {
  supports(fileName: string): boolean {
    return fileName.toLowerCase().endsWith('.ofx');
  }

  async parse(fileBuffer: Buffer): Promise<NormalizedBankRecord[]> {
    const content = fileBuffer.toString('utf-8');
    const parsed = await ofx.parse(content);

    const bankTx =
      parsed?.OFX?.BANKMSGSRSV1?.STMTTRNRS?.STMTRS?.BANKTRANLIST?.STMTTRN ?? [];

    const list = Array.isArray(bankTx) ? bankTx : [bankTx];

    return list.filter(Boolean).map((tx: any) => ({
      date: this.parseOfxDate(tx.DTPOSTED),
      amount: parseFloat(tx.TRNAMT),
      rawDescription: (tx.MEMO || tx.NAME || '').trim(),
      fitId: tx.FITID,
    }));
  }

  private parseOfxDate(dtposted: string): Date {
    // Formato OFX: YYYYMMDDHHMMSS[.xxx][:GMT]
    const clean = dtposted.substring(0, 8);
    const year = parseInt(clean.substring(0, 4), 10);
    const month = parseInt(clean.substring(4, 6), 10) - 1;
    const day = parseInt(clean.substring(6, 8), 10);
    return new Date(year, month, day);
  }
}
