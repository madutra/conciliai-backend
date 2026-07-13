-- CreateTable
CREATE TABLE `bank_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `bankCode` VARCHAR(191) NULL,
    `accountNumber` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_batches` (
    `id` VARCHAR(191) NOT NULL,
    `bankAccountId` VARCHAR(191) NOT NULL,
    `referenceMonth` VARCHAR(191) NOT NULL,
    `status` ENUM('UPLOADED', 'PROCESSING', 'MATCHED', 'REVIEWED', 'CLOSED') NOT NULL DEFAULT 'UPLOADED',
    `bankFileName` VARCHAR(191) NULL,
    `ledgerFileName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `reconciliation_batches_bankAccountId_idx`(`bankAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_transactions` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `rawDescription` VARCHAR(500) NOT NULL,
    `fitId` VARCHAR(191) NULL,
    `status` ENUM('UNMATCHED', 'MATCHED', 'PARTIAL') NOT NULL DEFAULT 'UNMATCHED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bank_transactions_batchId_status_idx`(`batchId`, `status`),
    INDEX `bank_transactions_batchId_date_amount_idx`(`batchId`, `date`, `amount`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_entries` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `historico` VARCHAR(500) NOT NULL,
    `documentNumber` VARCHAR(191) NULL,
    `accountCode` VARCHAR(191) NULL,
    `status` ENUM('UNMATCHED', 'MATCHED', 'PARTIAL') NOT NULL DEFAULT 'UNMATCHED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ledger_entries_batchId_status_idx`(`batchId`, `status`),
    INDEX `ledger_entries_batchId_date_amount_idx`(`batchId`, `date`, `amount`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `matches` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `matchType` ENUM('EXACT', 'FUZZY_DATE', 'MANY_TO_ONE', 'AI_SEMANTIC', 'MANUAL') NOT NULL,
    `confidence` DOUBLE NOT NULL DEFAULT 1.0,
    `reasoning` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `matches_batchId_idx`(`batchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `match_bank_transactions` (
    `matchId` VARCHAR(191) NOT NULL,
    `bankTransactionId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`matchId`, `bankTransactionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `match_ledger_entries` (
    `matchId` VARCHAR(191) NOT NULL,
    `ledgerEntryId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`matchId`, `ledgerEntryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `divergences` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `type` ENUM('MISSING_IN_LEDGER', 'MISSING_IN_BANK', 'VALUE_MISMATCH', 'DUPLICATE') NOT NULL,
    `bankTransactionId` VARCHAR(191) NULL,
    `ledgerEntryId` VARCHAR(191) NULL,
    `aiExplanation` TEXT NULL,
    `suggestedCause` VARCHAR(255) NULL,
    `suggestedAccount` VARCHAR(50) NULL,
    `aiConfidence` DOUBLE NULL,
    `status` ENUM('OPEN', 'RESOLVED', 'IGNORED') NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `divergences_batchId_status_idx`(`batchId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_runs` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `agentName` VARCHAR(191) NOT NULL,
    `input` TEXT NOT NULL,
    `output` TEXT NOT NULL,
    `tokensUsed` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `agent_runs_batchId_agentName_idx`(`batchId`, `agentName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `reconciliation_batches` ADD CONSTRAINT `reconciliation_batches_bankAccountId_fkey` FOREIGN KEY (`bankAccountId`) REFERENCES `bank_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_transactions` ADD CONSTRAINT `bank_transactions_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `reconciliation_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_entries` ADD CONSTRAINT `ledger_entries_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `reconciliation_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `matches` ADD CONSTRAINT `matches_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `reconciliation_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `match_bank_transactions` ADD CONSTRAINT `match_bank_transactions_matchId_fkey` FOREIGN KEY (`matchId`) REFERENCES `matches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `match_bank_transactions` ADD CONSTRAINT `match_bank_transactions_bankTransactionId_fkey` FOREIGN KEY (`bankTransactionId`) REFERENCES `bank_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `match_ledger_entries` ADD CONSTRAINT `match_ledger_entries_matchId_fkey` FOREIGN KEY (`matchId`) REFERENCES `matches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `match_ledger_entries` ADD CONSTRAINT `match_ledger_entries_ledgerEntryId_fkey` FOREIGN KEY (`ledgerEntryId`) REFERENCES `ledger_entries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `divergences` ADD CONSTRAINT `divergences_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `reconciliation_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `divergences` ADD CONSTRAINT `divergences_bankTransactionId_fkey` FOREIGN KEY (`bankTransactionId`) REFERENCES `bank_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `divergences` ADD CONSTRAINT `divergences_ledgerEntryId_fkey` FOREIGN KEY (`ledgerEntryId`) REFERENCES `ledger_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agent_runs` ADD CONSTRAINT `agent_runs_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `reconciliation_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
