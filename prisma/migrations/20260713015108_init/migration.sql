-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'MATCHED', 'REVIEWED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('EXACT', 'FUZZY_DATE', 'MANY_TO_ONE', 'AI_SEMANTIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "DivergenceType" AS ENUM ('MISSING_IN_LEDGER', 'MISSING_IN_BANK', 'VALUE_MISMATCH', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "DivergenceStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankCode" TEXT,
    "accountNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_batches" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "referenceMonth" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "bankFileName" TEXT,
    "ledgerFileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "rawDescription" VARCHAR(500) NOT NULL,
    "fitId" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "historico" VARCHAR(500) NOT NULL,
    "documentNumber" TEXT,
    "accountCode" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "matchType" "MatchType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "reasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_bank_transactions" (
    "matchId" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,

    CONSTRAINT "match_bank_transactions_pkey" PRIMARY KEY ("matchId","bankTransactionId")
);

-- CreateTable
CREATE TABLE "match_ledger_entries" (
    "matchId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,

    CONSTRAINT "match_ledger_entries_pkey" PRIMARY KEY ("matchId","ledgerEntryId")
);

-- CreateTable
CREATE TABLE "divergences" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "type" "DivergenceType" NOT NULL,
    "bankTransactionId" TEXT,
    "ledgerEntryId" TEXT,
    "aiExplanation" TEXT,
    "suggestedCause" VARCHAR(255),
    "suggestedAccount" VARCHAR(50),
    "aiConfidence" DOUBLE PRECISION,
    "status" "DivergenceStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "divergences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "tokensUsed" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_batches_bankAccountId_idx" ON "reconciliation_batches"("bankAccountId");

-- CreateIndex
CREATE INDEX "bank_transactions_batchId_status_idx" ON "bank_transactions"("batchId", "status");

-- CreateIndex
CREATE INDEX "bank_transactions_batchId_date_amount_idx" ON "bank_transactions"("batchId", "date", "amount");

-- CreateIndex
CREATE INDEX "ledger_entries_batchId_status_idx" ON "ledger_entries"("batchId", "status");

-- CreateIndex
CREATE INDEX "ledger_entries_batchId_date_amount_idx" ON "ledger_entries"("batchId", "date", "amount");

-- CreateIndex
CREATE INDEX "matches_batchId_idx" ON "matches"("batchId");

-- CreateIndex
CREATE INDEX "divergences_batchId_status_idx" ON "divergences"("batchId", "status");

-- CreateIndex
CREATE INDEX "agent_runs_batchId_agentName_idx" ON "agent_runs"("batchId", "agentName");

-- AddForeignKey
ALTER TABLE "reconciliation_batches" ADD CONSTRAINT "reconciliation_batches_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "reconciliation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "reconciliation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "reconciliation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_bank_transactions" ADD CONSTRAINT "match_bank_transactions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_bank_transactions" ADD CONSTRAINT "match_bank_transactions_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "bank_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_ledger_entries" ADD CONSTRAINT "match_ledger_entries_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_ledger_entries" ADD CONSTRAINT "match_ledger_entries_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "reconciliation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "reconciliation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
