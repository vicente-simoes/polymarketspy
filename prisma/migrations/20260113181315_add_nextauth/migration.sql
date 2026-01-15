-- CreateEnum
CREATE TYPE "ConfigScope" AS ENUM ('GLOBAL', 'USER');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('MERGE', 'SPLIT', 'REDEEM');

-- CreateEnum
CREATE TYPE "PortfolioScope" AS ENUM ('SHADOW_USER', 'EXEC_USER', 'EXEC_GLOBAL');

-- CreateEnum
CREATE TYPE "CopyDecision" AS ENUM ('EXECUTE', 'SKIP');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TRADE_FILL', 'MERGE', 'SPLIT', 'FEE', 'MARK', 'SETTLEMENT');

-- CreateTable
CREATE TABLE "FollowedUser" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "profileWallet" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowedUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowedUserProxyWallet" (
    "id" TEXT NOT NULL,
    "followedUserId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,

    CONSTRAINT "FollowedUserProxyWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardrailConfig" (
    "id" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "followedUserId" TEXT,
    "configJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopySizingConfig" (
    "id" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "followedUserId" TEXT,
    "configJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopySizingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "closeTime" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutcomeAsset" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "OutcomeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "txHash" TEXT,
    "logIndex" INTEGER,
    "isCanonical" BOOLEAN NOT NULL DEFAULT false,
    "profileWallet" TEXT NOT NULL,
    "proxyWallet" TEXT,
    "marketId" TEXT,
    "assetId" TEXT,
    "side" "TradeSide" NOT NULL,
    "priceMicros" INTEGER NOT NULL,
    "shareMicros" BIGINT NOT NULL,
    "notionalMicros" BIGINT NOT NULL,
    "feeMicros" BIGINT,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "detectTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "isCanonical" BOOLEAN NOT NULL DEFAULT false,
    "profileWallet" TEXT NOT NULL,
    "proxyWallet" TEXT,
    "type" "ActivityType" NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "detectTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyAttempt" (
    "id" TEXT NOT NULL,
    "portfolioScope" "PortfolioScope" NOT NULL,
    "followedUserId" TEXT,
    "groupKey" TEXT NOT NULL,
    "decision" "CopyDecision" NOT NULL,
    "reasonCodes" TEXT[],
    "targetNotionalMicros" BIGINT NOT NULL,
    "filledNotionalMicros" BIGINT NOT NULL DEFAULT 0,
    "vwapPriceMicros" INTEGER,
    "filledRatioBps" INTEGER NOT NULL DEFAULT 0,
    "theirReferencePriceMicros" INTEGER NOT NULL,
    "midPriceMicrosAtDecision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutableFill" (
    "id" TEXT NOT NULL,
    "copyAttemptId" TEXT NOT NULL,
    "filledShareMicros" BIGINT NOT NULL,
    "fillPriceMicros" INTEGER NOT NULL,
    "fillNotionalMicros" BIGINT NOT NULL,

    CONSTRAINT "ExecutableFill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "portfolioScope" "PortfolioScope" NOT NULL,
    "followedUserId" TEXT,
    "marketId" TEXT,
    "assetId" TEXT,
    "entryType" "LedgerEntryType" NOT NULL,
    "shareDeltaMicros" BIGINT NOT NULL,
    "cashDeltaMicros" BIGINT NOT NULL,
    "priceMicros" INTEGER,
    "refId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "portfolioScope" "PortfolioScope" NOT NULL,
    "followedUserId" TEXT,
    "bucketTime" TIMESTAMP(3) NOT NULL,
    "equityMicros" BIGINT NOT NULL,
    "cashMicros" BIGINT NOT NULL,
    "exposureMicros" BIGINT NOT NULL,
    "unrealizedPnlMicros" BIGINT NOT NULL,
    "realizedPnlMicros" BIGINT NOT NULL,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPriceSnapshot" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bucketTime" TIMESTAMP(3) NOT NULL,
    "midpointPriceMicros" INTEGER NOT NULL,

    CONSTRAINT "MarketPriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemCheckpoint" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllowedAdminEmail" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllowedAdminEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowedUser_profileWallet_key" ON "FollowedUser"("profileWallet");

-- CreateIndex
CREATE UNIQUE INDEX "FollowedUserProxyWallet_wallet_key" ON "FollowedUserProxyWallet"("wallet");

-- CreateIndex
CREATE INDEX "FollowedUserProxyWallet_followedUserId_idx" ON "FollowedUserProxyWallet"("followedUserId");

-- CreateIndex
CREATE INDEX "GuardrailConfig_scope_idx" ON "GuardrailConfig"("scope");

-- CreateIndex
CREATE INDEX "GuardrailConfig_followedUserId_idx" ON "GuardrailConfig"("followedUserId");

-- CreateIndex
CREATE INDEX "CopySizingConfig_scope_idx" ON "CopySizingConfig"("scope");

-- CreateIndex
CREATE INDEX "CopySizingConfig_followedUserId_idx" ON "CopySizingConfig"("followedUserId");

-- CreateIndex
CREATE INDEX "Market_conditionId_idx" ON "Market"("conditionId");

-- CreateIndex
CREATE INDEX "Market_closeTime_idx" ON "Market"("closeTime");

-- CreateIndex
CREATE INDEX "OutcomeAsset_marketId_idx" ON "OutcomeAsset"("marketId");

-- CreateIndex
CREATE INDEX "TradeEvent_profileWallet_eventTime_idx" ON "TradeEvent"("profileWallet", "eventTime");

-- CreateIndex
CREATE INDEX "TradeEvent_proxyWallet_eventTime_idx" ON "TradeEvent"("proxyWallet", "eventTime");

-- CreateIndex
CREATE INDEX "TradeEvent_assetId_eventTime_idx" ON "TradeEvent"("assetId", "eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "TradeEvent_source_sourceId_key" ON "TradeEvent"("source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeEvent_txHash_logIndex_key" ON "TradeEvent"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "ActivityEvent_profileWallet_eventTime_idx" ON "ActivityEvent"("profileWallet", "eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_source_sourceId_key" ON "ActivityEvent"("source", "sourceId");

-- CreateIndex
CREATE INDEX "CopyAttempt_portfolioScope_createdAt_idx" ON "CopyAttempt"("portfolioScope", "createdAt");

-- CreateIndex
CREATE INDEX "CopyAttempt_followedUserId_createdAt_idx" ON "CopyAttempt"("followedUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyAttempt_portfolioScope_followedUserId_groupKey_key" ON "CopyAttempt"("portfolioScope", "followedUserId", "groupKey");

-- CreateIndex
CREATE INDEX "ExecutableFill_copyAttemptId_idx" ON "ExecutableFill"("copyAttemptId");

-- CreateIndex
CREATE INDEX "LedgerEntry_portfolioScope_createdAt_idx" ON "LedgerEntry"("portfolioScope", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_assetId_createdAt_idx" ON "LedgerEntry"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_portfolioScope_refId_entryType_key" ON "LedgerEntry"("portfolioScope", "refId", "entryType");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_portfolioScope_bucketTime_idx" ON "PortfolioSnapshot"("portfolioScope", "bucketTime");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_followedUserId_bucketTime_idx" ON "PortfolioSnapshot"("followedUserId", "bucketTime");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_portfolioScope_followedUserId_bucketTime_key" ON "PortfolioSnapshot"("portfolioScope", "followedUserId", "bucketTime");

-- CreateIndex
CREATE INDEX "MarketPriceSnapshot_assetId_bucketTime_idx" ON "MarketPriceSnapshot"("assetId", "bucketTime");

-- CreateIndex
CREATE UNIQUE INDEX "MarketPriceSnapshot_assetId_bucketTime_key" ON "MarketPriceSnapshot"("assetId", "bucketTime");

-- CreateIndex
CREATE UNIQUE INDEX "SystemCheckpoint_key_key" ON "SystemCheckpoint"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AllowedAdminEmail_email_key" ON "AllowedAdminEmail"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- AddForeignKey
ALTER TABLE "FollowedUserProxyWallet" ADD CONSTRAINT "FollowedUserProxyWallet_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "FollowedUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardrailConfig" ADD CONSTRAINT "GuardrailConfig_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "FollowedUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopySizingConfig" ADD CONSTRAINT "CopySizingConfig_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "FollowedUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeAsset" ADD CONSTRAINT "OutcomeAsset_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyAttempt" ADD CONSTRAINT "CopyAttempt_followedUserId_fkey" FOREIGN KEY ("followedUserId") REFERENCES "FollowedUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutableFill" ADD CONSTRAINT "ExecutableFill_copyAttemptId_fkey" FOREIGN KEY ("copyAttemptId") REFERENCES "CopyAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
