import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchLeg, MatchType, Prisma } from '@prisma/client';
import { buildCommonTokenSet, docTokensOverlap } from '../common/document-number.util';

const DATE_WINDOW_DAYS = 3; // compensação bancária costuma variar D+1 a D+3
const OFFSET_WINDOW_DAYS = 31; // baixa + cancelamento podem se separar por semanas
const AMOUNT_EPSILON = 0.01; // tolerância de centavo por arredondamento
const SUBSET_MAX_CANDIDATES = 24; // folha de pagamento chega a ~20 linhas no mesmo dia
const SUBSET_MAX_NODES = 250_000; // teto de nós na busca, pra não explodir

// Ponta de origem de um registro dentro de uma perna da conciliação
type SourceKind = 'bank' | 'financial' | 'ledger';

// Forma uniforme que TODA ponta assume dentro do motor — o matching não
// sabe (nem precisa saber) se o registro veio do banco, financeiro ou razão.
interface MatchRecord {
  id: string;
  date: Date;
  amount: number;
  documentNumber: string | null;
}

interface LegStats {
  internalOffset: number;
  docNumber: number;
  exact: number;
  fuzzyDate: number;
  manyToOne: number;
  remainingA: number;
  remainingB: number;
}

/**
 * Motor determinístico de conciliação em 3 pontas. Roda ANTES de qualquer IA.
 *
 * A conciliação real tem duas pernas independentes:
 *   A) banco vs financeiro   — o extrato do financeiro tem que espelhar o banco
 *   B) financeiro vs razão   — o razão contábil tem que fechar com o financeiro
 * (sem arquivo do financeiro, cai no modo 2 pontas: banco vs razão)
 *
 * Ordem de estratégias (da mais confiável pra mais permissiva):
 *   1. Doc number (mesmo documento/NF + mesmo valor)
 *   2. Match exato (mesma data, mesmo valor)
 *   3. Janela de data (mesmo valor, data próxima)
 *   4. Many-to-one nas DUAS direções (N lançamentos somam 1 do outro lado)
 *      — cobre banco agrupando cobranças que o razão quebra por título,
 *        e folha de pagamento consolidada no banco aberta por funcionário.
 * O que sobrar vira candidato para o Investigator Agent (IA).
 */
@Injectable()
export class MatchingEngineService {
  private readonly logger = new Logger(MatchingEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runDeterministicMatching(batchId: string) {
    const hasFinancial = (await this.prisma.financialEntry.count({ where: { batchId } })) > 0;

    const legs: Record<string, LegStats> = {};
    if (hasFinancial) {
      legs.bankVsFinancial = await this.runLeg(batchId, MatchLeg.BANK_VS_FINANCIAL);
      legs.financialVsLedger = await this.runLeg(batchId, MatchLeg.FINANCIAL_VS_LEDGER);
    } else {
      legs.bankVsLedger = await this.runLeg(batchId, MatchLeg.BANK_VS_LEDGER);
    }

    this.logger.log(`Batch ${batchId}: ${JSON.stringify(legs)}`);
    return { threeWay: hasFinancial, legs };
  }

  private async runLeg(batchId: string, leg: MatchLeg): Promise<LegStats> {
    const [kindA, kindB] = this.legSides(leg);
    let sideA = await this.loadUnmatched(batchId, leg, kindA);
    let sideB = await this.loadUnmatched(batchId, leg, kindB);

    const stats: LegStats = { internalOffset: 0, docNumber: 0, exact: 0, fuzzyDate: 0, manyToOne: 0, remainingA: 0, remainingB: 0 };

    // Tokens que aparecem em dezenas de registros (nº da carteira de
    // cobrança, convênio) não identificam documento — fora do match por doc.
    const commonTokens = buildCommonTokenSet(
      [...sideA, ...sideB].map((r) => r.documentNumber),
    );

    // Antes de cruzar os lados, anula o "ruído interno" de cada fonte:
    // baixa + cancelamento de baixa do mesmo título se anulam e nunca
    // teriam par do outro lado.
    sideA = await this.netInternalOffsets(batchId, leg, kindA, sideA, commonTokens, stats);
    sideB = await this.netInternalOffsets(batchId, leg, kindB, sideB, commonTokens, stats);

    ({ sideA, sideB } = await this.matchOneToOne(batchId, leg, sideA, sideB, 'doc', commonTokens, stats));
    ({ sideA, sideB } = await this.matchOneToOne(batchId, leg, sideA, sideB, 'exact', commonTokens, stats));
    ({ sideA, sideB } = await this.matchOneToOne(batchId, leg, sideA, sideB, 'window', commonTokens, stats));

    // Duas fases de agrupamento, nas duas direções: primeiro só grupos
    // COMPLETOS do dia (alta confiança — folha de pagamento, liquidação da
    // cobrança), depois subconjuntos. A ordem importa: o grupo completo
    // reivindica suas linhas antes que um subset coincidente as roube.
    ({ sideA, sideB } = await this.matchManyToOne(batchId, leg, sideA, sideB, false, 'complete', stats));
    ({ sideA, sideB } = await this.matchManyToOne(batchId, leg, sideA, sideB, true, 'complete', stats));
    ({ sideA, sideB } = await this.matchManyToOne(batchId, leg, sideA, sideB, false, 'subset', stats));
    ({ sideA, sideB } = await this.matchManyToOne(batchId, leg, sideA, sideB, true, 'subset', stats));

    stats.remainingA = sideA.length;
    stats.remainingB = sideB.length;
    return stats;
  }

  /**
   * Par "baixa + cancelamento de baixa" (ou estorno) dentro da MESMA fonte:
   * mesmo documento, valores exatamente opostos. Se anulam entre si — não
   * existe movimentação real pra procurar do outro lado. Exige documento em
   * comum de propósito: só valor oposto seria arriscado demais.
   */
  private async netInternalOffsets(
    batchId: string,
    leg: MatchLeg,
    kind: SourceKind,
    side: MatchRecord[],
    commonTokens: Set<string>,
    stats: LegStats,
  ): Promise<MatchRecord[]> {
    const used = new Set<string>();

    for (let i = 0; i < side.length; i++) {
      const a = side[i];
      if (used.has(a.id) || a.amount === 0 || !a.documentNumber) continue;

      for (let j = i + 1; j < side.length; j++) {
        const b = side[j];
        if (used.has(b.id)) continue;
        if (!this.sameAmount(a.amount, -b.amount)) continue;
        if (!docTokensOverlap(a.documentNumber, b.documentNumber, commonTokens)) continue;
        if (!this.withinDays(a.date, b.date, OFFSET_WINDOW_DAYS)) continue;

        await this.createInternalMatch(batchId, leg, kind, [a.id, b.id]);
        used.add(a.id);
        used.add(b.id);
        stats.internalOffset++;
        break;
      }
    }

    return side.filter((r) => !used.has(r.id));
  }

  private async matchOneToOne(
    batchId: string,
    leg: MatchLeg,
    sideA: MatchRecord[],
    sideB: MatchRecord[],
    strategy: 'doc' | 'exact' | 'window',
    commonTokens: Set<string>,
    stats: LegStats,
  ) {
    const usedB = new Set<string>();
    const remainingA: MatchRecord[] = [];

    for (const a of sideA) {
      const candidate = sideB.find((b) => {
        if (usedB.has(b.id) || !this.sameAmount(a.amount, b.amount)) return false;
        if (strategy === 'doc') {
          // doc igual segura mesmo com data deslocada, mas dentro da janela
          return (
            docTokensOverlap(a.documentNumber, b.documentNumber, commonTokens) &&
            this.withinDays(a.date, b.date, DATE_WINDOW_DAYS)
          );
        }
        if (strategy === 'exact') return this.sameDay(a.date, b.date);
        return this.withinDays(a.date, b.date, DATE_WINDOW_DAYS);
      });

      if (candidate) {
        const [type, confidence] =
          strategy === 'doc'
            ? [MatchType.DOC_NUMBER, 1.0]
            : strategy === 'exact'
              ? [MatchType.EXACT, 1.0]
              : [MatchType.FUZZY_DATE, 0.9];
        await this.createMatch(batchId, leg, type, confidence, [a], [candidate]);
        usedB.add(candidate.id);
        if (strategy === 'doc') stats.docNumber++;
        else if (strategy === 'exact') stats.exact++;
        else stats.fuzzyDate++;
      } else {
        remainingA.push(a);
      }
    }

    return { sideA: remainingA, sideB: sideB.filter((b) => !usedB.has(b.id)) };
  }

  /**
   * Caso clássico das 3 pontas: o banco consolida (1 liquidação de cobrança,
   * 1 folha de pagamento) o que o financeiro/razão registra por título ou
   * por funcionário. Procura, pra cada lançamento "solto" de um lado, um
   * subconjunto do outro lado cuja soma bate — nas duas direções.
   */
  private async matchManyToOne(
    batchId: string,
    leg: MatchLeg,
    sideA: MatchRecord[],
    sideB: MatchRecord[],
    reversed: boolean,
    mode: 'complete' | 'subset',
    stats: LegStats,
  ) {
    const [singles, parts] = reversed ? [sideB, sideA] : [sideA, sideB];
    const usedParts = new Set<string>();
    const remainingSingles: MatchRecord[] = [];

    for (const single of singles) {
      // Grupos sempre de UM único dia: misturar dias multiplica a chance de
      // subset coincidente. Dias testados do mais próximo pro mais distante.
      const combo = this.findDayGroupCombo(single, parts, usedParts, mode);

      if (combo) {
        const [recordsA, recordsB] = reversed ? [combo, [single]] : [[single], combo];
        await this.createMatch(batchId, leg, MatchType.MANY_TO_ONE, 0.85, recordsA, recordsB);
        combo.forEach((c) => usedParts.add(c.id));
        stats.manyToOne++;
      } else {
        remainingSingles.push(single);
      }
    }

    const remainingParts = parts.filter((p) => !usedParts.has(p.id));
    return reversed
      ? { sideA: remainingParts, sideB: remainingSingles }
      : { sideA: remainingSingles, sideB: remainingParts };
  }

  private findDayGroupCombo(
    single: MatchRecord,
    parts: MatchRecord[],
    usedParts: Set<string>,
    mode: 'complete' | 'subset',
  ): MatchRecord[] | null {
    // agrupa candidatos elegíveis por dia
    const byDay = new Map<string, MatchRecord[]>();
    for (const p of parts) {
      if (usedParts.has(p.id)) continue;
      if (Math.sign(p.amount) !== Math.sign(single.amount)) continue;
      if (!this.withinDays(single.date, p.date, DATE_WINDOW_DAYS)) continue;
      const key = p.date.toDateString();
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(p);
    }

    const days = [...byDay.entries()].sort(
      (a, b) =>
        Math.abs(new Date(a[0]).getTime() - single.date.getTime()) -
        Math.abs(new Date(b[0]).getTime() - single.date.getTime()),
    );

    for (const [, group] of days) {
      if (group.length < 2) continue;
      const groupSum = group.reduce((s, p) => s + p.amount, 0);
      if (this.sameAmount(groupSum, single.amount)) return group;
      if (mode === 'subset') {
        const combo = this.findSubsetSum(group, single.amount);
        if (combo && combo.length > 1) return combo;
      }
    }
    return null;
  }

  /**
   * Subset-sum em centavos com DFS podada: ordena decrescente, corta o ramo
   * quando o que resta não alcança o alvo ou quando já passou. Aguenta
   * janelas maiores (folha de pagamento com ~20 linhas) sem explodir —
   * e tem teto de nós pra garantir que nunca trava o pipeline.
   */
  private findSubsetSum(items: MatchRecord[], target: number): MatchRecord[] | null {
    const sorted = [...items]
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, SUBSET_MAX_CANDIDATES);
    const n = sorted.length;
    if (n < 2) return null;

    const cents = sorted.map((i) => Math.round(Math.abs(i.amount) * 100));
    const targetCents = Math.round(Math.abs(target) * 100);
    const suffixSum: number[] = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) suffixSum[i] = suffixSum[i + 1] + cents[i];
    if (suffixSum[0] < targetCents) return null;

    // Atalho comum: o grupo INTEIRO soma o alvo (folha de pagamento,
    // liquidação do dia) — sem busca nenhuma.
    if (suffixSum[0] === targetCents) return sorted;

    let nodes = 0;
    const picked: number[] = [];

    const dfs = (index: number, remaining: number): boolean => {
      if (remaining === 0) return picked.length > 1;
      if (index >= n || nodes++ > SUBSET_MAX_NODES) return false;
      if (suffixSum[index] < remaining) return false;

      // tenta incluir o item atual
      if (cents[index] <= remaining) {
        picked.push(index);
        if (dfs(index + 1, remaining - cents[index])) return true;
        picked.pop();
      }
      // pula duplicatas do mesmo valor pra não revisitar o mesmo ramo
      let next = index + 1;
      while (next < n && cents[next] === cents[index]) next++;
      return dfs(next, remaining);
    };

    if (!dfs(0, targetCents)) return null;
    return picked.map((i) => sorted[i]);
  }

  // ── Persistência e acesso por ponta ────────────────────────────────────

  private legSides(leg: MatchLeg): [SourceKind, SourceKind] {
    switch (leg) {
      case MatchLeg.BANK_VS_FINANCIAL:
        return ['bank', 'financial'];
      case MatchLeg.FINANCIAL_VS_LEDGER:
        return ['financial', 'ledger'];
      case MatchLeg.BANK_VS_LEDGER:
        return ['bank', 'ledger'];
    }
  }

  private async loadUnmatched(batchId: string, leg: MatchLeg, kind: SourceKind): Promise<MatchRecord[]> {
    if (kind === 'bank') {
      const rows = await this.prisma.bankTransaction.findMany({ where: { batchId, status: 'UNMATCHED' } });
      return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), documentNumber: r.documentNumber }));
    }
    if (kind === 'ledger') {
      const rows = await this.prisma.ledgerEntry.findMany({ where: { batchId, status: 'UNMATCHED' } });
      return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), documentNumber: r.documentNumber }));
    }
    // financeiro concilia de forma independente contra cada lado
    const statusField = leg === MatchLeg.BANK_VS_FINANCIAL ? 'statusVsBank' : 'statusVsLedger';
    const rows = await this.prisma.financialEntry.findMany({ where: { batchId, [statusField]: 'UNMATCHED' } });
    return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), documentNumber: r.documentNumber }));
  }

  private async createMatch(
    batchId: string,
    leg: MatchLeg,
    matchType: MatchType,
    confidence: number,
    recordsA: MatchRecord[],
    recordsB: MatchRecord[],
  ) {
    const [kindA, kindB] = this.legSides(leg);

    await this.prisma.$transaction(async (tx) => {
      const match = await tx.match.create({ data: { batchId, leg, matchType, confidence } });
      await this.linkAndMark(tx, match.id, leg, kindA, recordsA.map((r) => r.id));
      await this.linkAndMark(tx, match.id, leg, kindB, recordsB.map((r) => r.id));
    });
  }

  // Match interno: os dois registros ficam na MESMA ponta (baixa + estorno)
  private async createInternalMatch(batchId: string, leg: MatchLeg, kind: SourceKind, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const match = await tx.match.create({
        data: {
          batchId,
          leg,
          matchType: MatchType.INTERNAL_OFFSET,
          confidence: 1.0,
          reasoning: 'Baixa e cancelamento do mesmo documento se anulam dentro da própria fonte',
        },
      });
      await this.linkAndMark(tx, match.id, leg, kind, ids);
    });
  }

  private async linkAndMark(
    tx: Prisma.TransactionClient,
    matchId: string,
    leg: MatchLeg,
    kind: SourceKind,
    ids: string[],
  ) {
    if (kind === 'bank') {
      await tx.matchBankTransaction.createMany({
        data: ids.map((id) => ({ matchId, bankTransactionId: id })),
      });
      await tx.bankTransaction.updateMany({ where: { id: { in: ids } }, data: { status: 'MATCHED' } });
    } else if (kind === 'ledger') {
      await tx.matchLedgerEntry.createMany({
        data: ids.map((id) => ({ matchId, ledgerEntryId: id })),
      });
      await tx.ledgerEntry.updateMany({ where: { id: { in: ids } }, data: { status: 'MATCHED' } });
    } else {
      await tx.matchFinancialEntry.createMany({
        data: ids.map((id) => ({ matchId, financialEntryId: id })),
      });
      const statusField = leg === MatchLeg.BANK_VS_FINANCIAL ? 'statusVsBank' : 'statusVsLedger';
      await tx.financialEntry.updateMany({ where: { id: { in: ids } }, data: { [statusField]: 'MATCHED' } });
    }
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
