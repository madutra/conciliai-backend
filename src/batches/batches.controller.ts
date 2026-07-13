import { Body, Controller, Post, Get, Param, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrchestratorService } from '../ai-agents/orchestrator.service';

@Controller('batches')
export class BatchesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  @Post()
  async createBatch(@Body() body: { bankAccountId: string; referenceMonth: string }) {
    return this.prisma.reconciliationBatch.create({
      data: { bankAccountId: body.bankAccountId, referenceMonth: body.referenceMonth },
    });
  }

  @Get()
  async findAll(@Query('bankAccountId') bankAccountId?: string) {
    return this.prisma.reconciliationBatch.findMany({
      where: bankAccountId ? { bankAccountId } : undefined,
      include: { bankAccount: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get(':batchId')
  async findOne(@Param('batchId') batchId: string) {
    return this.prisma.reconciliationBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { bankAccount: true },
    });
  }

  @Post(':batchId/run')
  async runReconciliation(@Param('batchId') batchId: string) {
    return this.orchestrator.runFullReconciliation(batchId);
  }
}
