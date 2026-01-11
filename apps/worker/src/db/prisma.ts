import { PrismaClient } from "@prisma/client";
import { logger } from "../log/logger.js";

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: [
            { level: "error", emit: "event" },
            { level: "warn", emit: "event" },
        ],
    });

prisma.$on("error" as never, (e: unknown) => {
    logger.error({ err: e }, "Prisma error");
});

prisma.$on("warn" as never, (e: unknown) => {
    logger.warn({ warning: e }, "Prisma warning");
});

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}
