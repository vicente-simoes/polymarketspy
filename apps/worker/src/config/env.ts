import { z } from "zod";

const envSchema = z.object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string(),
    ALCHEMY_WS_URL: z.string().url(),
    POLYMARKET_DATA_API_BASE_URL: z.string().url(),
    POLYMARKET_CLOB_BASE_URL: z.string().url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    WORKER_PORT: z.coerce.number().default(8081),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
        console.error("❌ Invalid environment variables:");
        console.error(result.error.format());
        process.exit(1);
    }
    return result.data;
}

export const env = loadEnv();
