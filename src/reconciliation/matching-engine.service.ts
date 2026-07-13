import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BankTransaction, LedgerEntry, MatchType } from '@prisma/client';

const DATE_WINDOW_DAYS = 3; // compensação bancária costuma variar D+1 a D+3
const AMOUNT_EPSILON = 0.01; // tolerância de centavo por arredondamento

/**
 * Motor determinístico de conciliação. Roda ANTES de qualquer chamada de IA.
 * Ordem de estratégias (da mais confiável pra mais permissiva):
 *   1. Match exato (mesma data, mesmo valor)
 *   2. Match por janela de data (mesmo valor, data próxima)
 *   3. Match many-to-one (N lançamentos do razão somam 1 transação do banco, ou vice-versa)
 * O que sobrar vira candidato para o Investigator Agent (IA).
 */
@Injectable()
export class MatchingEngineService {
  private readonly logger = new Logger(MatchingEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runDeterministicMatching(batchId: string) {
    let bankTx = await this.prisma.bankTransaction.findMany({
      where: { batchId, status: 'UNMATCHED' },
    });
    let ledgerTx = await this.prisma.ledgerEntry.findMany({
      where: { batchId, status: 'UNMATCHED' },
    });

    const stats = { exact: 0, fuzzyDate: 0, manyToOne: 0 };

    // 1. Match exato
    ({ bankTx, ledgerTx } = await this.matchExact(batchId, bankTx, ledgerTx, stats));

    // 2. Match por janela de data
    ({ bankTx, ledgerTx } = await this.matchByDateWindow(batchId, bankTx, ledgerTx, stats));

    // 3. Match many-to-one (agrupamento por soma)
    ({ bankTx, ledgerTx } = await this.matchManyToOne(batchId, bankTx, ledgerTx, stats));

    this.logger.log(
      `Batch ${batchId}: exact=${stats.exact} fuzzyDate=${stats.fuzzyDate} manyToOne=${stats.manyToOne} restantes=${bankTx.length + ledgerTx.length}`,
    );

    return {
      ...stats,
      remainingBankTx: bankTx.length,
      remainingLedgerTx: ledgerTx.length,
    };
  }

  private async matchExact(
    batchId: string,
    bankTx: BankTransaction[],
    ledgerTx: LedgerEntry[],
    stats: Record<string, number>,
  ) {
    const usedLedgerIds = new Set<string>();
    const remainingBank: BankTransaction[] = [];

    for (const bt of bankTx) {
      const candidate = ledgerTx.find(
        (lt) =>
          !usedLedgerIds.has(lt.id) &&
          this.sameDay(bt.date, lt.date) &&
          this.sameAmount(Number(bt.amount), Number(lt.amount)),
      );

      if (candidate) {
        await this.createMatch(batchId, MatchType.EXACT, 1.0, [bt.id], [candidate.id]);
        usedLedgerIds.add(candidate.id);
        stats.exact++;
      } else {
        remainingBank.push(bt);
      }
    }

    return {
      bankTx: remainingBank,
      ledgerTx: ledgerTx.filter((lt) => !usedLedgerIds.has(lt.id)),
    };
  }

  private async matchByDateWindow(
    batchId: string,
    bankTx: BankTransaction[],
    ledgerTx: LedgerEntry[],
    stats: Record<string, number>,
  ) {
    const usedLedgerIds = new Set<string>();
    const remainingBank: BankTransaction[] = [];

    for (const bt of bankTx) {
      const candidate = ledgerTx.find(
        (lt) =>
          !usedLedgerIds.has(lt.id) &&
          this.withinDays(bt.date, lt.date, DATE_WINDOW_DAYS) &&
          this.sameAmount(Number(bt.amount), Number(lt.amount)),
      );

      if (candidate) {
        await this.createMatch(batchId, MatchType.FUZZY_DATE, 0.9, [bt.id], [candidate.id]);
        usedLedgerIds.add(candidate.id);
        stats.fuzzyDate++;
      } else {
        remainingBank.push(bt);
      }
    }

    return {
      bankTx: remainingBank,
      ledgerTx: ledgerTx.filter((lt) => !usedLedgerIds.has(lt.id)),
    };
  }

  /**
   * Caso clássico: 3 boletos lançados separadamente no Protheus caem como
   * 1 único depósito consolidado no extrato (ou o inverso).
   * Estratégia: para cada transação "solta", procura um subconjunto do outro
   * lado, dentro da mesma janela de data, cuja soma bate o valor.
   */
  private async matchManyToOne(
    batchId: string,
    bankTx: BankTransaction[],
    ledgerTx: LedgerEntry[],
    stats: Record<string, number>,
  ) {
    const usedLedgerIds = new Set<string>();
    const remainingBank: BankTransaction[] = [];

    for (const bt of bankTx) {
      const nearbyLedger = ledgerTx.filter(
        (lt) => !usedLedgerIds.has(lt.id) && this.withinDays(bt.date, lt.date, DATE_WINDOW_DAYS),
      );

      const combo = this.findSubsetSum(nearbyLedger, Number(bt.amount));

      if (combo && combo.length > 1) {
        await this.createMatch(
          batchId,
          MatchType.MANY_TO_ONE,
          0.85,
          [bt.id],
          combo.map((c) => c.id),
        );
        combo.forEach((c) => usedLedgerIds.add(c.id));
        stats.manyToOne++;
      } else {
        remainingBank.push(bt);
      }
    }

    return {
      bankTx: remainingBank,
      ledgerTx: ledgerTx.filter((lt) => !usedLedgerIds.has(lt.id)),
    };
  }

  // Busca exaustiva só é viável com poucos candidatos por janela de data
  // (na prática, poucos lançamentos caem no mesmo dia/conta). Limita a 12
  // candidatos para não explodir combinatoriamente.
  private findSubsetSum(items: LedgerEntry[], target: number): LedgerEntry[] | null {
    const limited = items.slice(0, 12);
    const n = limited.length;
    if (n === 0) return null;

    for (let mask = 1; mask < 1 << n; mask++) {
      let sum = 0;
      const subset: LedgerEntry[] = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          sum += Number(limited[i].amount);
          subset.push(limited[i]);
        }
      }
      if (this.sameAmount(sum, target)) {
        return subset;
      }
    }
    return null;
  }

  private async createMatch(
    batchId: string,
    matchType: MatchType,
    confidence: number,
    bankTxIds: string[],
    ledgerIds: string[],
  ) {
    await this.prisma.$transaction(async (tx) => {
      const match = await tx.match.create({
        data: { batchId, matchType, confidence },
      });

      await tx.matchBankTransaction.createMany({
        data: bankTxIds.map((id) => ({ matchId: match.id, bankTransactionId: id })),
      });
      await tx.matchLedgerEntry.createMany({
        data: ledgerIds.map((id) => ({ matchId: match.id, ledgerEntryId: id })),
      });

      await tx.bankTransaction.updateMany({
        where: { id: { in: bankTxIds } },
        data: { status: 'MATCHED' },
      });
      await tx.ledgerEntry.updateMany({
        where: { id: { in: ledgerIds } },
        data: { status: 'MATCHED' },
      });
    });
  }

  private sameDay(a: Date, b: Date): boolean {
    return a.toDateString() === b.toDateString();
  }

  private withinDays(a: Date, b: Date, days: number): boolean {
    const diff = Math.abs(a.getTime() - b.getTime());
    return diff <= days * 24 * 60 * 60 * 1000;
  }

  private sameAmount(a: number, b: number): boolean {
    return Math.abs(a - b) <= AMOUNT_EPSILON;
  }
}
