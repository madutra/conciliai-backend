import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { AiAgentsModule } from './ai-agents/ai-agents.module';
import { BatchesModule } from './batches/batches.module';
import { BankAccountsModule } from './bank-accounts/bank-accounts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    IngestionModule,
    ReconciliationModule,
    AiAgentsModule,
    BatchesModule,
    BankAccountsModule,
  ],
})
export class AppModule {}
