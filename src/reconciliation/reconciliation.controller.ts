import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DivergenceStatus } from '@prisma/client';

@Controller('batches/:batchId')
export class ReconciliationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async getSummary(@Param('batchId') batchId: string) {
    const [
      bankTotal,
      bankMatched,
      financialTotal,
      financialMatchedVsBank,
      financialMatchedVsLedger,
      ledgerTotal,
      ledgerMatched,
      divergences,
    ] = await Promise.all([
      this.prisma.bankTransaction.count({ where: { batchId } }),
      this.prisma.bankTransaction.count({ where: { batchId, status: 'MATCHED' } }),
      this.prisma.financialEntry.count({ where: { batchId } }),
      this.prisma.financialEntry.count({ where: { batchId, statusVsBank: 'MATCHED' } }),
      this.prisma.financialEntry.count({ where: { batchId, statusVsLedger: 'MATCHED' } }),
      this.prisma.ledgerEntry.count({ where: { batchId } }),
      this.prisma.ledgerEntry.count({ where: { batchId, status: 'MATCHED' } }),
      this.prisma.divergence.findMany({
        where: { batchId },
        include: { bankTransaction: true, financialEntry: true, ledgerEntry: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      threeWay: financialTotal > 0,
      bank: { total: bankTotal, matched: bankMatched, pct: bankTotal ? bankMatched / bankTotal : 0 },
      financial: {
        total: financialTotal,
        matchedVsBank: financialMatchedVsBank,
        matchedVsLedger: financialMatchedVsLedger,
        pctVsBank: financialTotal ? financialMatchedVsBank / financialTotal : 0,
        pctVsLedger: financialTotal ? financialMatchedVsLedger / financialTotal : 0,
      },
      ledger: { total: ledgerTotal, matched: ledgerMatched, pct: ledgerTotal ? ledgerMatched / ledgerTotal : 0 },
      divergences,
    };
  }

  @Get('matches')
  async getMatches(@Param('batchId') batchId: string) {
    return this.prisma.match.findMany({
      where: { batchId },
      include: {
        bankTransactions: { include: { bankTransaction: true } },
        financialEntries: { include: { financialEntry: true } },
        ledgerEntries: { include: { ledgerEntry: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Patch('divergences/:divergenceId')
  async updateDivergenceStatus(
    @Param('batchId') batchId: string,
    @Param('divergenceId') divergenceId: string,
    @Body() body: { status: DivergenceStatus },
  ) {
    const divergence = await this.prisma.divergence.update({
      where: { id: divergenceId },
      data: { status: body.status },
    });

    // Revisão concluída quando não resta divergência aberta; reaberta volta a MATCHED
    const openCount = await this.prisma.divergence.count({ where: { batchId, status: 'OPEN' } });
    await this.prisma.reconciliationBatch.updateMany({
      where: { id: batchId, status: { in: ['MATCHED', 'REVIEWED'] } },
      data: { status: openCount === 0 ? 'REVIEWED' : 'MATCHED' },
    });

    return divergence;
  }
}
