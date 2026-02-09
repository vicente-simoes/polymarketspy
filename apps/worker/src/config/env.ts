import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

// Load env in two layers:
// 1) Project root `.env` (shared defaults)
// 2) `apps/worker/.env` (worker-specific overrides, local dev)
//
// Note: In Docker builds, `.env` files are typically not copied into the runtime
// image; Docker Compose should provide env vars explicitly. These calls are
// primarily for local `pnpm dev` / `node dist` workflows.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(__dirname, "../../../../.env") });

config({ path: resolve(process.cwd(), "apps/worker/.env"), override: true });
// Support both TS (`.../apps/worker/src/config`) and built JS (`.../apps/worker/dist/config`)
config({ path: resolve(__dirname, "../../../.env"), override: true });
config({ path: resolve(__dirname, "../../.env"), override: true });

const envSchema = z.object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string(),
    ALCHEMY_WS_URL: z.string().url(),
    ALCHEMY_WS_ENABLED: z
        .string()
        .transform((v) => v.toLowerCase() !== "false" && v !== "0")
        .default("true"),
    CLOB_BOOK_WS_ENABLED: z
        .string()
        .transform((v) => v.toLowerCase() !== "false" && v !== "0")
        .default("true"),
    POLYMARKET_DATA_API_BASE_URL: z.string().url(),
    POLYMARKET_CLOB_BASE_URL: z.string().url(),
    GAMMA_API_BASE_URL: z.string().url().default("https://gamma-api.polymarket.com"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    WORKER_PORT: z.coerce.number().default(8081),

    // BullMQ concurrency guardrails (defaults chosen for low-CPU single-droplet deployments)
    WORKER_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().default(2),
    WORKER_CONCURRENCY_INGEST: z.coerce.number().int().positive().optional(),
    WORKER_CONCURRENCY_GROUP: z.coerce.number().int().positive().optional(),
    WORKER_CONCURRENCY_COPY_GLOBAL: z.coerce.number().int().positive().optional(),
    WORKER_CONCURRENCY_RECONCILE: z.coerce.number().int().positive().optional(),
    WORKER_CONCURRENCY_PRICES: z.coerce.number().int().positive().optional(),

    // Live trading credentials (optional - only required when live trading is enabled)
    POLYMARKET_LIVE_PRIVATE_KEY: z.string().optional(),
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
