-- CreateEnum
CREATE TYPE "AccountNature" AS ENUM ('ASSET', 'LIABILITY');

-- CreateEnum
CREATE TYPE "MatchLeg" AS ENUM ('BANK_VS_FINANCIAL', 'FINANCIAL_VS_LEDGER', 'BANK_VS_LEDGER');

-- AlterEnum
ALTER TYPE "DivergenceType" ADD VALUE 'MISSING_IN_FINANCIAL';

-- DropIndex
DROP INDEX "matches_batchId_idx";

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "nature" "AccountNature" NOT NULL DEFAULT 'ASSET';

-- AlterTable
ALTER TABLE "bank_transactions" ADD COLUMN     "documentNumber" TEXT;

-- AlterTable
ALTER TABLE "divergences" ADD COLUMN     "financialEntryId" TEXT,
ADD COLUMN     "leg" "MatchLeg" NOT NULL DEFAULT 'BANK_VS_LEDGER';

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "leg" "MatchLeg" NOT NULL DEFAULT 'BANK_VS_LEDGER';

-- AlterTable
ALTER TABLE "reconciliation_batches" ADD COLUMN     "financialFileName" TEXT;

-- CreateTable
CREATE TABLE "financial_entries" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "documentNumber" TEXT,
    "statusVsBank" "TxStatus" NOT NULL DEFAULT 'UNMATCHED',
    "statusVsLedger" "TxStatus" NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_financial_entries" (
    "matchId" TEXT NOT NULL,
    "financialEntryId" TEXT NOT NULL,

    CONSTRAINT "match_financial_entries_pkey" PRIMARY KEY ("matchId","financialEntryId")
);

-- CreateIndex
CREATE INDEX "financial_entries_batchId_statusVsBank_idx" ON "financial_entries"("batchId", "statusVsBank");

-- CreateIndex
CREATE INDEX "financial_entries_batchId_statusVsLedger_idx" ON "financial_entries"("batchId", "statusVsLedger");

-- CreateIndex
CREATE INDEX "financial_entries_batchId_date_amount_idx" ON "financial_entries"("batchId", "date", "amount");

-- CreateIndex
CREATE INDEX "matches_batchId_leg_idx" ON "matches"("batchId", "leg");

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "reconciliation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_financial_entries" ADD CONSTRAINT "match_financial_entries_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_financial_entries" ADD CONSTRAINT "match_financial_entries_financialEntryId_fkey" FOREIGN KEY ("financialEntryId") REFERENCES "financial_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_financialEntryId_fkey" FOREIGN KEY ("financialEntryId") REFERENCES "financial_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
