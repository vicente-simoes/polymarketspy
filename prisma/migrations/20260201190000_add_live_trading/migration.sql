-- Migration: Add Live Trading Support
-- This migration adds TradingMode dimension to existing tables and creates new live trading tables

-- ============================================
-- STEP 1: Create new enums
-- ============================================

CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');
CREATE TYPE "LiveOrderStatus" AS ENUM ('CREATED', 'SUBMITTING', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'FAILED', 'SUBMISSION_UNKNOWN');
CREATE TYPE "LiveFillOrigin" AS ENUM ('APP', 'EXTERNAL');
CREATE TYPE "LiveOrderType" AS ENUM ('FAK', 'FOK', 'GTC');
CREATE TYPE "LiveOverride" AS ENUM ('INHERIT', 'FORCE_ON', 'FORCE_OFF');

-- ============================================
-- STEP 2: Add tradingMode and liveOverride to existing tables
-- ============================================

-- FollowedUser: add liveOverride
ALTER TABLE "FollowedUser" ADD COLUMN "liveOverride" "LiveOverride" NOT NULL DEFAULT 'INHERIT';

-- GuardrailConfig: add tradingMode
ALTER TABLE "GuardrailConfig" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';
CREATE INDEX "GuardrailConfig_tradingMode_idx" ON "GuardrailConfig"("tradingMode");

-- CopySizingConfig: add tradingMode
ALTER TABLE "CopySizingConfig" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';
CREATE INDEX "CopySizingConfig_tradingMode_idx" ON "CopySizingConfig"("tradingMode");

-- CopyAttempt: add tradingMode and update unique constraint
ALTER TABLE "CopyAttempt" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';
DROP INDEX IF EXISTS "CopyAttempt_portfolioScope_createdAt_idx";
DROP INDEX IF EXISTS "CopyAttempt_portfolioScope_followedUserId_groupKey_key";
CREATE UNIQUE INDEX "CopyAttempt_tradingMode_portfolioScope_followedUserId_groupKey_key" ON "CopyAttempt"("tradingMode", "portfolioScope", "followedUserId", "groupKey");
CREATE INDEX "CopyAttempt_tradingMode_portfolioScope_createdAt_idx" ON "CopyAttempt"("tradingMode", "portfolioScope", "createdAt");

-- LedgerEntry: add tradingMode and update unique constraint
ALTER TABLE "LedgerEntry" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';
DROP INDEX IF EXISTS "LedgerEntry_portfolioScope_createdAt_idx";
DROP INDEX IF EXISTS "LedgerEntry_portfolioScope_assetId_entryType_createdAt_idx";
DROP INDEX IF EXISTS "LedgerEntry_portfolioScope_refId_entryType_key";
CREATE UNIQUE INDEX "LedgerEntry_tradingMode_portfolioScope_refId_entryType_key" ON "LedgerEntry"("tradingMode", "portfolioScope", "refId", "entryType");
CREATE INDEX "LedgerEntry_tradingMode_portfolioScope_createdAt_idx" ON "LedgerEntry"("tradingMode", "portfolioScope", "createdAt");
CREATE INDEX "LedgerEntry_tradingMode_portfolioScope_assetId_entryType_createdAt_idx" ON "LedgerEntry"("tradingMode", "portfolioScope", "assetId", "entryType", "createdAt");

-- ============================================
-- STEP 3: Migrate CurrentPosition (change from assetId @id to uuid @id + unique constraint)
-- ============================================

-- Add new id column as nullable first
ALTER TABLE "CurrentPosition" ADD COLUMN "id_new" TEXT;
ALTER TABLE "CurrentPosition" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- Populate UUIDs for existing rows
UPDATE "CurrentPosition" SET "id_new" = gen_random_uuid()::text WHERE "id_new" IS NULL;

-- Drop old primary key constraint
ALTER TABLE "CurrentPosition" DROP CONSTRAINT "CurrentPosition_pkey";

-- Rename columns
ALTER TABLE "CurrentPosition" RENAME COLUMN "assetId" TO "assetId_old";
ALTER TABLE "CurrentPosition" RENAME COLUMN "id_new" TO "id";

-- Make id NOT NULL and add primary key
ALTER TABLE "CurrentPosition" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "CurrentPosition" ADD PRIMARY KEY ("id");

-- Rename assetId back
ALTER TABLE "CurrentPosition" RENAME COLUMN "assetId_old" TO "assetId";

-- Add new unique constraint
CREATE UNIQUE INDEX "CurrentPosition_tradingMode_assetId_key" ON "CurrentPosition"("tradingMode", "assetId");
CREATE INDEX "CurrentPosition_tradingMode_idx" ON "CurrentPosition"("tradingMode");

-- ============================================
-- STEP 4: Migrate CurrentPositionByLeader (change from composite @id to uuid @id + unique constraint)
-- ============================================

-- Add new id column as nullable first
ALTER TABLE "CurrentPositionByLeader" ADD COLUMN "id_new" TEXT;
ALTER TABLE "CurrentPositionByLeader" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- Populate UUIDs for existing rows
UPDATE "CurrentPositionByLeader" SET "id_new" = gen_random_uuid()::text WHERE "id_new" IS NULL;

-- Drop old primary key constraint
ALTER TABLE "CurrentPositionByLeader" DROP CONSTRAINT "CurrentPositionByLeader_pkey";

-- Rename column
ALTER TABLE "CurrentPositionByLeader" RENAME COLUMN "id_new" TO "id";

-- Make id NOT NULL and add primary key
ALTER TABLE "CurrentPositionByLeader" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "CurrentPositionByLeader" ADD PRIMARY KEY ("id");

-- Update indexes
DROP INDEX IF EXISTS "CurrentPositionByLeader_followedUserId_idx";
CREATE UNIQUE INDEX "CurrentPositionByLeader_tradingMode_assetId_followedUserId_key" ON "CurrentPositionByLeader"("tradingMode", "assetId", "followedUserId");
CREATE INDEX "CurrentPositionByLeader_tradingMode_followedUserId_idx" ON "CurrentPositionByLeader"("tradingMode", "followedUserId");

-- ============================================
-- STEP 5: Migrate GlobalPortfolioState (add tradingMode + portfolioScope)
-- ============================================

-- Add new columns
ALTER TABLE "GlobalPortfolioState" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';
ALTER TABLE "GlobalPortfolioState" ADD COLUMN "portfolioScope" "PortfolioScope" NOT NULL DEFAULT 'EXEC_GLOBAL';

-- For existing rows, the id was likely "EXEC_GLOBAL" - we'll keep it but add the unique constraint
-- Generate new UUID for existing rows
UPDATE "GlobalPortfolioState" SET "id" = gen_random_uuid()::text;

-- Add unique constraint
CREATE UNIQUE INDEX "GlobalPortfolioState_tradingMode_portfolioScope_key" ON "GlobalPortfolioState"("tradingMode", "portfolioScope");

-- ============================================
-- STEP 6: Migrate EquityPoint (change from composite @id to uuid @id + unique constraint)
-- ============================================

-- Add new id column as nullable first
ALTER TABLE "EquityPoint" ADD COLUMN "id_new" TEXT;
ALTER TABLE "EquityPoint" ADD COLUMN "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- Populate UUIDs for existing rows
UPDATE "EquityPoint" SET "id_new" = gen_random_uuid()::text WHERE "id_new" IS NULL;

-- Drop old primary key constraint
ALTER TABLE "EquityPoint" DROP CONSTRAINT "EquityPoint_pkey";

-- Rename column
ALTER TABLE "EquityPoint" RENAME COLUMN "id_new" TO "id";

-- Make id NOT NULL and add primary key
ALTER TABLE "EquityPoint" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "EquityPoint" ADD PRIMARY KEY ("id");

-- Add new unique constraint and index
CREATE UNIQUE INDEX "EquityPoint_tradingMode_granularity_bucketTime_key" ON "EquityPoint"("tradingMode", "granularity", "bucketTime");
CREATE INDEX "EquityPoint_tradingMode_granularity_idx" ON "EquityPoint"("tradingMode", "granularity");

-- ============================================
-- STEP 7: Create new live trading tables
-- ============================================

-- LiveOrder table
CREATE TABLE "LiveOrder" (
    "id" TEXT NOT NULL,
    "copyAttemptId" TEXT,
    "followedUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "clobOrderId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "orderType" "LiveOrderType" NOT NULL DEFAULT 'FAK',
    "limitPriceMicros" INTEGER NOT NULL,
    "sizeShareMicros" BIGINT NOT NULL,
    "bestBidMicrosAtDecision" INTEGER,
    "bestAskMicrosAtDecision" INTEGER,
    "bookSource" "BookSource",
    "bookAgeMs" INTEGER,
    "filledShareMicros" BIGINT NOT NULL DEFAULT 0,
    "filledNotionalMicros" BIGINT NOT NULL DEFAULT 0,
    "avgFillPriceMicros" INTEGER,
    "status" "LiveOrderStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "lastUpdateAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,

    CONSTRAINT "LiveOrder_pkey" PRIMARY KEY ("id")
);

-- LiveFill table
CREATE TABLE "LiveFill" (
    "id" TEXT NOT NULL,
    "liveOrderId" TEXT,
    "origin" "LiveFillOrigin" NOT NULL DEFAULT 'APP',
    "tradeId" TEXT NOT NULL,
    "clobOrderId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "matchedAt" TIMESTAMP(3) NOT NULL,
    "priceMicros" INTEGER NOT NULL,
    "shareMicros" BIGINT NOT NULL,
    "notionalMicros" BIGINT NOT NULL,
    "feeMicros" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveFill_pkey" PRIMARY KEY ("id")
);

-- TokenTradingParamsCache table
CREATE TABLE "TokenTradingParamsCache" (
    "tokenId" TEXT NOT NULL,
    "tickSizeMicros" INTEGER NOT NULL,
    "minOrderSizeShareMicros" BIGINT NOT NULL,
    "sizeStepShareMicros" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenTradingParamsCache_pkey" PRIMARY KEY ("tokenId")
);

-- ============================================
-- STEP 8: Add indexes and constraints for new tables
-- ============================================

-- LiveOrder indexes and constraints
CREATE UNIQUE INDEX "LiveOrder_copyAttemptId_key" ON "LiveOrder"("copyAttemptId");
CREATE UNIQUE INDEX "LiveOrder_idempotencyKey_key" ON "LiveOrder"("idempotencyKey");
CREATE UNIQUE INDEX "LiveOrder_clientOrderId_key" ON "LiveOrder"("clientOrderId");
CREATE UNIQUE INDEX "LiveOrder_clobOrderId_key" ON "LiveOrder"("clobOrderId");
CREATE INDEX "LiveOrder_status_idx" ON "LiveOrder"("status");
CREATE INDEX "LiveOrder_createdAt_idx" ON "LiveOrder"("createdAt");
CREATE INDEX "LiveOrder_tokenId_createdAt_idx" ON "LiveOrder"("tokenId", "createdAt");
CREATE INDEX "LiveOrder_followedUserId_createdAt_idx" ON "LiveOrder"("followedUserId", "createdAt");

-- LiveFill indexes and constraints
CREATE UNIQUE INDEX "LiveFill_tradeId_key" ON "LiveFill"("tradeId");
CREATE INDEX "LiveFill_matchedAt_idx" ON "LiveFill"("matchedAt");
CREATE INDEX "LiveFill_clobOrderId_idx" ON "LiveFill"("clobOrderId");
CREATE INDEX "LiveFill_tokenId_matchedAt_idx" ON "LiveFill"("tokenId", "matchedAt");
CREATE INDEX "LiveFill_origin_idx" ON "LiveFill"("origin");

-- TokenTradingParamsCache indexes
CREATE INDEX "TokenTradingParamsCache_updatedAt_idx" ON "TokenTradingParamsCache"("updatedAt");

-- ============================================
-- STEP 9: Add foreign key constraints
-- ============================================

-- LiveOrder foreign keys
ALTER TABLE "LiveOrder" ADD CONSTRAINT "LiveOrder_copyAttemptId_fkey" FOREIGN KEY ("copyAttemptId") REFERENCES "CopyAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveOrder" ADD CONSTRAINT "LiveOrder_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "FollowedUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- LiveFill foreign keys
ALTER TABLE "LiveFill" ADD CONSTRAINT "LiveFill_liveOrderId_fkey" FOREIGN KEY ("liveOrderId") REFERENCES "LiveOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
