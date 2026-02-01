-- CreateEnum
CREATE TYPE "EquityPointGranularity" AS ENUM ('M1', 'M20', 'H2', 'H12', 'D1');

-- CreateTable
CREATE TABLE "CurrentPrice" (
    "assetId" TEXT NOT NULL,
    "midpointPriceMicros" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentPrice_pkey" PRIMARY KEY ("assetId")
);

-- CreateTable
CREATE TABLE "CurrentPosition" (
    "assetId" TEXT NOT NULL,
    "marketId" TEXT,
    "shareMicros" BIGINT NOT NULL,
    "netCashFlowMicros" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentPosition_pkey" PRIMARY KEY ("assetId")
);

-- CreateTable
CREATE TABLE "CurrentPositionByLeader" (
    "assetId" TEXT NOT NULL,
    "followedUserId" TEXT NOT NULL,
    "marketId" TEXT,
    "shareMicros" BIGINT NOT NULL,
    "netCashFlowMicros" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentPositionByLeader_pkey" PRIMARY KEY ("assetId","followedUserId")
);

-- CreateTable
CREATE TABLE "GlobalPortfolioState" (
    "id" TEXT NOT NULL,
    "cashMicros" BIGINT NOT NULL,
    "contributedCapitalMicros" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalPortfolioState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquityPoint" (
    "granularity" "EquityPointGranularity" NOT NULL,
    "bucketTime" TIMESTAMP(3) NOT NULL,
    "equityMicros" BIGINT NOT NULL,
    "contributedCapitalMicros" BIGINT NOT NULL,
    "pnlMicros" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquityPoint_pkey" PRIMARY KEY ("granularity","bucketTime")
);

-- CreateIndex
CREATE INDEX "CurrentPosition_marketId_idx" ON "CurrentPosition"("marketId");

-- CreateIndex
CREATE INDEX "CurrentPositionByLeader_followedUserId_idx" ON "CurrentPositionByLeader"("followedUserId");

-- CreateIndex
CREATE INDEX "CurrentPositionByLeader_marketId_idx" ON "CurrentPositionByLeader"("marketId");

-- CreateIndex
CREATE INDEX "LedgerEntry_portfolioScope_assetId_entryType_createdAt_idx" ON "LedgerEntry"("portfolioScope", "assetId", "entryType", "createdAt");

