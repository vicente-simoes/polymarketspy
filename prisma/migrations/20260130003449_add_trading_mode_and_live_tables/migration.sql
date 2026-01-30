/*
  Warnings:

  - A unique constraint covering the columns `[tradingMode,portfolioScope,followedUserId,groupKey]` on the table `CopyAttempt` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tradingMode,scope,followedUserId]` on the table `CopySizingConfig` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tradingMode,scope,followedUserId]` on the table `GuardrailConfig` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tradingMode,portfolioScope,refId,entryType]` on the table `LedgerEntry` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tradingMode,portfolioScope,followedUserId,bucketTime]` on the table `PortfolioSnapshot` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "LiveOrderStatus" AS ENUM ('CREATED', 'SUBMITTING', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'FAILED', 'SUBMISSION_UNKNOWN');

-- CreateEnum
CREATE TYPE "LiveOrderType" AS ENUM ('FAK', 'FOK', 'GTC');

-- CreateEnum
CREATE TYPE "LiveFillOrigin" AS ENUM ('APP', 'EXTERNAL');

-- DropIndex
DROP INDEX "CopyAttempt_portfolioScope_followedUserId_groupKey_key";

-- DropIndex
DROP INDEX "LedgerEntry_portfolioScope_refId_entryType_key";

-- DropIndex
DROP INDEX "PortfolioSnapshot_portfolioScope_followedUserId_bucketTime_key";

-- AlterTable
ALTER TABLE "CopyAttempt" ADD COLUMN     "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- AlterTable
ALTER TABLE "CopySizingConfig" ADD COLUMN     "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- AlterTable
ALTER TABLE "GuardrailConfig" ADD COLUMN     "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- AlterTable
ALTER TABLE "PortfolioSnapshot" ADD COLUMN     "tradingMode" "TradingMode" NOT NULL DEFAULT 'PAPER';

-- CreateTable
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
    "bookSource" TEXT,
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

-- CreateTable
CREATE TABLE "LiveFill" (
    "id" TEXT NOT NULL,
    "liveOrderId" TEXT,
    "tradeId" TEXT NOT NULL,
    "clobOrderId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "priceMicros" INTEGER NOT NULL,
    "shareMicros" BIGINT NOT NULL,
    "notionalMicros" BIGINT NOT NULL,
    "feeMicros" BIGINT,
    "origin" "LiveFillOrigin" NOT NULL DEFAULT 'APP',
    "matchedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'MATCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveFill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenTradingParamsCache" (
    "tokenId" TEXT NOT NULL,
    "tickSizeMicros" INTEGER NOT NULL,
    "minOrderSizeShareMicros" BIGINT NOT NULL,
    "sizeStepShareMicros" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenTradingParamsCache_pkey" PRIMARY KEY ("tokenId")
);

-- CreateTable
CREATE TABLE "RealPositionSnapshot" (
    "id" TEXT NOT NULL,
    "bucketTime" TIMESTAMP(3) NOT NULL,
    "tokenId" TEXT NOT NULL,
    "shareMicros" BIGINT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'RECONCILE',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealPositionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveOrder_idempotencyKey_key" ON "LiveOrder"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LiveOrder_clientOrderId_key" ON "LiveOrder"("clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveOrder_clobOrderId_key" ON "LiveOrder"("clobOrderId");

-- CreateIndex
CREATE INDEX "LiveOrder_status_idx" ON "LiveOrder"("status");

-- CreateIndex
CREATE INDEX "LiveOrder_createdAt_idx" ON "LiveOrder"("createdAt");

-- CreateIndex
CREATE INDEX "LiveOrder_tokenId_createdAt_idx" ON "LiveOrder"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "LiveOrder_followedUserId_idx" ON "LiveOrder"("followedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveFill_tradeId_key" ON "LiveFill"("tradeId");

-- CreateIndex
CREATE INDEX "LiveFill_matchedAt_idx" ON "LiveFill"("matchedAt");

-- CreateIndex
CREATE INDEX "LiveFill_clobOrderId_idx" ON "LiveFill"("clobOrderId");

-- CreateIndex
CREATE INDEX "LiveFill_tokenId_matchedAt_idx" ON "LiveFill"("tokenId", "matchedAt");

-- CreateIndex
CREATE INDEX "LiveFill_origin_idx" ON "LiveFill"("origin");

-- CreateIndex
CREATE INDEX "TokenTradingParamsCache_updatedAt_idx" ON "TokenTradingParamsCache"("updatedAt");

-- CreateIndex
CREATE INDEX "RealPositionSnapshot_bucketTime_idx" ON "RealPositionSnapshot"("bucketTime");

-- CreateIndex
CREATE INDEX "RealPositionSnapshot_tokenId_bucketTime_idx" ON "RealPositionSnapshot"("tokenId", "bucketTime");

-- CreateIndex
CREATE UNIQUE INDEX "RealPositionSnapshot_tokenId_bucketTime_key" ON "RealPositionSnapshot"("tokenId", "bucketTime");

-- CreateIndex
CREATE INDEX "CopyAttempt_tradingMode_createdAt_idx" ON "CopyAttempt"("tradingMode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyAttempt_tradingMode_portfolioScope_followedUserId_group_key" ON "CopyAttempt"("tradingMode", "portfolioScope", "followedUserId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "CopySizingConfig_tradingMode_scope_followedUserId_key" ON "CopySizingConfig"("tradingMode", "scope", "followedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardrailConfig_tradingMode_scope_followedUserId_key" ON "GuardrailConfig"("tradingMode", "scope", "followedUserId");

-- CreateIndex
CREATE INDEX "LedgerEntry_tradingMode_portfolioScope_createdAt_idx" ON "LedgerEntry"("tradingMode", "portfolioScope", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_tradingMode_portfolioScope_refId_entryType_key" ON "LedgerEntry"("tradingMode", "portfolioScope", "refId", "entryType");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_tradingMode_portfolioScope_bucketTime_idx" ON "PortfolioSnapshot"("tradingMode", "portfolioScope", "bucketTime");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_tradingMode_portfolioScope_followedUserId_key" ON "PortfolioSnapshot"("tradingMode", "portfolioScope", "followedUserId", "bucketTime");

-- AddForeignKey
ALTER TABLE "LiveOrder" ADD CONSTRAINT "LiveOrder_copyAttemptId_fkey" FOREIGN KEY ("copyAttemptId") REFERENCES "CopyAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveOrder" ADD CONSTRAINT "LiveOrder_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "FollowedUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveFill" ADD CONSTRAINT "LiveFill_liveOrderId_fkey" FOREIGN KEY ("liveOrderId") REFERENCES "LiveOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
