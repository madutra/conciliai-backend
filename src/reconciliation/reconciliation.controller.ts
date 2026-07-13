import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DivergenceStatus } from '@prisma/client';

@Controller('batches/:batchId')
export class ReconciliationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async getSummary(@Param('batchId') batchId: string) {
    const [bankTotal, bankMatched, ledgerTotal, ledgerMatched, divergences] = await Promise.all([
      this.prisma.bankTransaction.count({ where: { batchId } }),
      this.prisma.bankTransaction.count({ where: { batchId, status: 'MATCHED' } }),
      this.prisma.ledgerEntry.count({ where: { batchId } }),
      this.prisma.ledgerEntry.count({ where: { batchId, status: 'MATCHED' } }),
      this.prisma.divergence.findMany({
        where: { batchId },
        include: { bankTransaction: true, ledgerEntry: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      bank: { total: bankTotal, matched: bankMatched, pct: bankTotal ? bankMatched / bankTotal : 0 },
      ledger: { total: ledgerTotal, matched: ledgerMatched, pct: ledgerTotal ? ledgerMatched / ledgerTotal : 0 },
      divergences,
    };
  }

  @Get('matches')
  async getMatches(@Param('batchId') batchId: string) {
    return this.prisma.match.findMany({
      where: { batchId },
      include: { bankTransactions: { include: { bankTransaction: true } }, ledgerEntries: { include: { ledgerEntry: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Patch('divergences/:divergenceId')
  async updateDivergenceStatus(
    @Param('divergenceId') divergenceId: string,
    @Body() body: { status: DivergenceStatus },
  ) {
    return this.prisma.divergence.update({
      where: { id: divergenceId },
      data: { status: body.status },
    });
  }
}
