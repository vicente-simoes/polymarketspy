-- CreateEnum
CREATE TYPE "BookSource" AS ENUM ('WS', 'REST');

-- AlterTable
ALTER TABLE "CopyAttempt"
ADD COLUMN "bookSource" "BookSource",
ADD COLUMN "usedRestFallback" BOOLEAN NOT NULL DEFAULT false;

