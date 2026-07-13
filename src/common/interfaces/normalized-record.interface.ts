// Formato canonico que TODO parser (OFX, CSV, PDF via IA) precisa devolver.
// É o contrato que desacopla "de onde veio o arquivo" de "como conciliamos".

export interface NormalizedBankRecord {
  date: Date;
  amount: number; // positivo = credito, negativo = debito
  rawDescription: string;
  fitId?: string;
}

export interface NormalizedLedgerRecord {
  date: Date;
  amount: number;
  historico: string;
  documentNumber?: string;
  accountCode?: string;
}

export interface FileParser<T> {
  supports(fileName: string): boolean;
  parse(fileBuffer: Buffer): Promise<T[]>;
}
