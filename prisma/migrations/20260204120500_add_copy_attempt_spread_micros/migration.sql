-- Add decision-time spread for CopyAttempt rows (helps explain SPREAD_TOO_WIDE skips).

ALTER TABLE "CopyAttempt" ADD COLUMN "spreadMicrosAtDecision" INTEGER;

