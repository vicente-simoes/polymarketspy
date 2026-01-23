-- CreateEnum
CREATE TYPE "CopySourceType" AS ENUM ('IMMEDIATE', 'BUFFER', 'AGGREGATOR');

-- AlterTable
ALTER TABLE "CopyAttempt" ADD COLUMN     "bufferedTradeCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sourceType" "CopySourceType" NOT NULL DEFAULT 'AGGREGATOR';
