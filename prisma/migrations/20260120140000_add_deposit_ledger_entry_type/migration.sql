-- Add a dedicated ledger entry type for cash injections.
-- Postgres enum values are append-only.
ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT';

