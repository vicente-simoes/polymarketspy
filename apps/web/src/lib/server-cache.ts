type CacheEntry<T> = {
    expiresAtMs: number
    value: T
}

declare global {
    // eslint-disable-next-line no-var
    var __serverCache: Map<string, CacheEntry<unknown>> | undefined
    // eslint-disable-next-line no-var
    var __serverCacheInflight: Map<string, Promise<unknown>> | undefined
}

const cache = globalThis.__serverCache ?? new Map<string, CacheEntry<unknown>>()
const inflight = globalThis.__serverCacheInflight ?? new Map<string, Promise<unknown>>()

globalThis.__serverCache = cache
globalThis.__serverCacheInflight = inflight

export async function getOrSetServerCache<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>
): Promise<T> {
    const nowMs = Date.now()
    const existing = cache.get(key)
    if (existing && existing.expiresAtMs > nowMs) {
        return existing.value as T
    }

    const pending = inflight.get(key)
    if (pending) {
        return pending as Promise<T>
    }

    const promise = loader()
        .then((value) => {
            cache.set(key, { expiresAtMs: Date.now() + ttlMs, value })
            inflight.delete(key)
            return value
        })
        .catch((err) => {
            inflight.delete(key)
            throw err
        })

    inflight.set(key, promise as Promise<unknown>)
    return promise
}

export function clearServerCache(prefix?: string): void {
    if (!prefix) {
        cache.clear()
        return
    }
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
            cache.delete(key)
        }
    }
}

