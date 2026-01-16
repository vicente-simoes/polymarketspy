-- CreateEnum
CREATE TYPE "EnrichmentStatus" AS ENUM ('PENDING', 'ENRICHED', 'FAILED');

-- AlterTable
ALTER TABLE "TradeEvent" ADD COLUMN     "conditionId" TEXT,
ADD COLUMN     "enrichedAt" TIMESTAMP(3),
ADD COLUMN     "enrichmentStatus" "EnrichmentStatus" NOT NULL DEFAULT 'ENRICHED',
ADD COLUMN     "rawTokenId" TEXT;

-- CreateTable
CREATE TABLE "TokenMetadataCache" (
    "tokenId" TEXT NOT NULL,
    "conditionId" TEXT,
    "marketId" TEXT,
    "marketSlug" TEXT,
    "outcomeLabel" TEXT,
    "marketTitle" TEXT,
    "closeTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenMetadataCache_pkey" PRIMARY KEY ("tokenId")
);

-- CreateIndex
CREATE INDEX "TokenMetadataCache_conditionId_idx" ON "TokenMetadataCache"("conditionId");

-- CreateIndex
CREATE INDEX "TokenMetadataCache_marketId_idx" ON "TokenMetadataCache"("marketId");

-- CreateIndex
CREATE INDEX "TradeEvent_enrichmentStatus_idx" ON "TradeEvent"("enrichmentStatus");
