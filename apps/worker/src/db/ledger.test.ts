import { describe, it, expect } from "vitest";
import { LedgerEntryType, PortfolioScope, Prisma } from "@prisma/client";
import { createLedgerEntryIfNotExistsAndUpdateCaches } from "./ledger.js";

function prismaUniqueViolation(): Prisma.PrismaClientKnownRequestError {
    // PrismaClientKnownRequestError ctor signature isn't part of the stable public API,
    // but in practice this matches prisma@5.x.
    // If this ever breaks, prefer changing the production code to detect `code === "P2002"`
    // without relying on `instanceof`.
    return new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        {
            code: "P2002",
            clientVersion: "test",
        }
    );
}

describe("createLedgerEntryIfNotExistsAndUpdateCaches", () => {
    it("applies cache deltas only once when the ledger entry already exists", async () => {
        const calls: Array<{ model: string; op: string }> = [];

        const tx: any = {
            ledgerEntry: {
                create: async () => {
                    calls.push({ model: "ledgerEntry", op: "create" });
                    return {
                        id: "le1",
                        portfolioScope: PortfolioScope.EXEC_GLOBAL,
                        followedUserId: "leader1",
                        marketId: "m1",
                        assetId: "a1",
                        entryType: LedgerEntryType.TRADE_FILL,
                        shareDeltaMicros: 2_000_000n,
                        cashDeltaMicros: -1_000_000n,
                        priceMicros: 500_000,
                        refId: "copy:abc",
                        createdAt: new Date(),
                    };
                },
            },
            globalPortfolioState: {
                upsert: async (args: unknown) => {
                    calls.push({ model: "globalPortfolioState", op: "upsert" });
                    return args;
                },
            },
            currentPosition: {
                upsert: async (args: unknown) => {
                    calls.push({ model: "currentPosition", op: "upsert" });
                    return args;
                },
            },
            currentPositionByLeader: {
                upsert: async (args: unknown) => {
                    calls.push({ model: "currentPositionByLeader", op: "upsert" });
                    return args;
                },
            },
        };

        const input = {
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            followedUserId: "leader1",
            marketId: "m1",
            assetId: "a1",
            entryType: LedgerEntryType.TRADE_FILL,
            shareDeltaMicros: 2_000_000n,
            cashDeltaMicros: -1_000_000n,
            priceMicros: 500_000,
            refId: "copy:abc",
        };

        const first = await createLedgerEntryIfNotExistsAndUpdateCaches(tx, input);
        expect(first.inserted).toBe(true);
        expect(
            calls.filter((c) => c.model === "globalPortfolioState" && c.op === "upsert")
        ).toHaveLength(1);
        expect(
            calls.filter((c) => c.model === "currentPosition" && c.op === "upsert")
        ).toHaveLength(1);
        expect(
            calls.filter((c) => c.model === "currentPositionByLeader" && c.op === "upsert")
        ).toHaveLength(1);

        // Now simulate unique violation on insert: caches must NOT be applied.
        tx.ledgerEntry.create = async () => {
            calls.push({ model: "ledgerEntry", op: "create" });
            throw prismaUniqueViolation();
        };

        const second = await createLedgerEntryIfNotExistsAndUpdateCaches(tx, input);
        expect(second.inserted).toBe(false);

        expect(
            calls.filter((c) => c.model === "globalPortfolioState" && c.op === "upsert")
        ).toHaveLength(1);
        expect(
            calls.filter((c) => c.model === "currentPosition" && c.op === "upsert")
        ).toHaveLength(1);
        expect(
            calls.filter((c) => c.model === "currentPositionByLeader" && c.op === "upsert")
        ).toHaveLength(1);
    });

    it("applies contributed capital increments for DEPOSIT entries", async () => {
        const upserts: any[] = [];

        const tx: any = {
            ledgerEntry: {
                create: async () => {
                    return {
                        id: "le2",
                        portfolioScope: PortfolioScope.EXEC_GLOBAL,
                        followedUserId: null,
                        marketId: null,
                        assetId: null,
                        entryType: LedgerEntryType.DEPOSIT,
                        shareDeltaMicros: 0n,
                        cashDeltaMicros: 10_000_000n,
                        priceMicros: null,
                        refId: "deposit:abc",
                        createdAt: new Date(),
                    };
                },
            },
            globalPortfolioState: {
                upsert: async (args: any) => {
                    upserts.push(args);
                    return args;
                },
            },
            currentPosition: { upsert: async () => {} },
            currentPositionByLeader: { upsert: async () => {} },
        };

        const input = {
            portfolioScope: PortfolioScope.EXEC_GLOBAL,
            followedUserId: null,
            marketId: null,
            assetId: null,
            entryType: LedgerEntryType.DEPOSIT,
            shareDeltaMicros: 0n,
            cashDeltaMicros: 10_000_000n,
            priceMicros: null,
            refId: "deposit:abc",
        };

        const result = await createLedgerEntryIfNotExistsAndUpdateCaches(tx, input);
        expect(result.inserted).toBe(true);
        expect(upserts).toHaveLength(1);
        expect(upserts[0]?.create?.contributedCapitalMicros).toBe(10_000_000n);
    });
});
