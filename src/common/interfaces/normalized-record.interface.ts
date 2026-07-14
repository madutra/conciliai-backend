// Formato canonico que TODO parser (OFX, CSV, PDF via IA) precisa devolver.
// É o contrato que desacopla "de onde veio o arquivo" de "como conciliamos".

export interface NormalizedBankRecord {
  date: Date;
  amount: number; // positivo = credito, negativo = debito
  rawDescription: string;
  fitId?: string;
  documentNumber?: string; // tokens extraídos do Dcto./descrição
}

// Extrato gerado pelo financeiro (SIGAFIN) — terceira ponta da conciliação
export interface NormalizedFinancialRecord {
  date: Date;
  amount: number; // mesma convenção do banco: positivo = entrada
  description: string;
  documentNumber?: string;
}

export interface NormalizedLedgerRecord {
  date: Date;
  amount: number;
  historico: string;
  documentNumber?: string;
  accountCode?: string;
  loteDocLinha?: string; // LOTE/SUB/DOC/LINHA do Protheus, quando houver
}

export interface FileParser<T> {
  supports(fileName: string): boolean;
  parse(fileBuffer: Buffer): Promise<T[]>;
}
