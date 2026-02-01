# CPU Saturation + DB Hot Query (MarketPriceSnapshot)

## Summary (what’s wrong)
The droplet repeatedly pegs CPU at ~100% whenever Docker services are up. When services are stopped (`docker compose down`), CPU drops. When services start again (`docker compose up -d`), CPU returns to ~100%. This is not a crash-loop: containers show **0 restarts** and are **not OOM-killed**. The evidence points to **CPU saturation driven by the worker + Postgres**, and specifically a **very frequent/heavy Postgres query on `MarketPriceSnapshot`** that likely returns too many rows (history) for a set of asset IDs.

Codex should inspect the codebase for the query pattern generating the repeated:

```sql
SELECT "MarketPriceSnapshot"."id", "MarketPriceSnapshot"."assetId", "MarketPriceSnapshot"."midpointPriceMicros"
FROM "MarketPriceSnapshot"
WHERE "MarketPriceSnapshot"."assetId" IN (...)
```

…and determine whether it is unintentionally fetching **all historical snapshots** instead of the **latest snapshot per asset** (or otherwise returning an unbounded dataset). This query pattern plus frequent polling/WS ingestion is causing constant CPU load and delays.

---

## Context (how we got here)

### Initial incident (before CPU investigation)
- The app ran fine for >1 day, then the web app became unreachable and SSH began failing (`kex_exchange_identification: read: Connection reset by peer`), and DigitalOcean console hung at “connecting”.
- After a power cycle, SSH worked again and the app recovered (services auto-started).

### What the system logs showed
The kernel log showed an **OOM kill** previously:
- `systemd invoked oom-killer ...`
- `Out of memory: Killed process ... (node) ...`

Command used:
```bash
sudo journalctl -k -b -1 --no-pager | egrep -i "oom|out of memory|killed process|hung task|I/O error|ext4|xfs" | tail -200
```

This established that memory pressure had been an earlier problem, but the current issue is primarily CPU saturation.

---

## Current symptoms (after resizing to 2 vCPU / 4GB)
- CPU in the DO graphs drops under 100% briefly after resizing, but returns to ~100% after services are started.
- The system only calms down when `docker compose down` is executed.
- User suspected worker instability; however, container restart counts indicate the worker is running continuously.

---

## Evidence collected

### Docker containers: who is consuming CPU?
Command:
```bash
docker stats --no-stream
```

Observed (representative snapshot):
- `polymarket-worker` ~105% CPU
- `polymarket-db` ~86% CPU
- others low

This totals ~190% CPU usage on a 2-vCPU host (near saturation).

### Worker is NOT crashing / restart-looping
Commands:
```bash
docker inspect polymarket-worker --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}} finished={{.State.FinishedAt}}'
docker inspect polymarket-web    --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}} finished={{.State.FinishedAt}}'
docker inspect polymarket-db     --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}} finished={{.State.FinishedAt}}'
```

Observed:
- `restarts=0`, `oom=false`, `exit=0` for worker/web/db.

Conclusion: worker issues are likely **performance/backlog** rather than a crash loop.

### Worker logs show constant ingestion/execution activity
Command:
```bash
docker logs --since 2h --tail 200 polymarket-worker
```

Logs include frequent events:
- websocket trade inserts (`Inserted canonical WS trade`)
- aggregator flushes (`Flushing trade group`)
- ingesters (`Starting trade ingestion`, `Fetched trades from API`)
- executor decisions (`Copy attempt decision ... EXECUTE/SKIP`)
This indicates a high-throughput loop that likely hits DB frequently.

### Postgres activity indicates a hot query on MarketPriceSnapshot
Command:
```bash
docker exec -it polymarket-db psql -U copybot -c "
SELECT pid, now()-query_start AS age, state, wait_event_type, wait_event,
       left(regexp_replace(query, '\s+', ' ', 'g'), 300) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY age DESC;"
```

Observed repeatedly:
```sql
SELECT "public"."MarketPriceSnapshot"."id",
       "public"."MarketPriceSnapshot"."assetId",
       "public"."MarketPriceSnapshot"."midpointPriceMicros"
FROM "public"."MarketPriceSnapshot"
WHERE "public"."MarketPriceSnapshot"."assetId" IN ($1,$2,$3,...)
```

Wait events:
- `IPC / MessageQueueSend`
- sometimes `ClientWrite`

Interpretation:
- Postgres is spending time **sending results** (and/or the client is slow to read), which strongly suggests **large result sets** and/or high frequency.

---

## Suspected root cause (most likely)
### 1) Query returns unbounded historical rows
The query has:
- `WHERE assetId IN (...)`
- **no timestamp filter**
- **no ORDER BY**
- **no LIMIT**
- **no distinct-per-asset logic**

If `MarketPriceSnapshot` stores many snapshots per asset, this query returns **all historical snapshots** for those asset IDs, which can be huge and will consume CPU+IO continuously.

### 2) Called very frequently by worker / web loop
Given worker logs and constant ingestion/execution, this query is likely executed:
- on a schedule (polling),
- per websocket event,
- per “executor decision” cycle,
- or per API request that triggers the worker.

That combination yields constant CPU load.

---

## Notes on indexes (what helps vs what doesn’t)

### Index attempted / proposed
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS mps_time_desc
ON "MarketPriceSnapshot" ("timestamp" DESC);
```

This **does not match** the observed hot query (which filters by `assetId` only). It is unlikely to help unless the query also filters/orders by timestamp.

### More relevant index if intent is “latest snapshot per asset”
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS mps_asset_ts_desc
ON "MarketPriceSnapshot" ("assetId", "timestamp" DESC);
```

But the bigger fix is **query shape**: fetch the latest per asset instead of all history.

---

## What Codex should search for in the codebase

### A) Where this query is generated
Look for Prisma/ORM calls equivalent to:
- `MarketPriceSnapshot.findMany({ where: { assetId: { in: [...] } } })`
- `SELECT id, assetId, midpointPriceMicros FROM MarketPriceSnapshot WHERE assetId IN (...)`
- any helper like `getMarketPriceSnapshots(assetIds)` or `getMidpointPrices(assetIds)`

### B) How often it runs
Find loops/timers/handlers such as:
- `setInterval(...)` / cron-like scheduling in the worker
- websocket message handlers that trigger reads
- “executor” / “enrichment” loops that run per event batch
- any retry loop that could become tight under errors (backoff missing)

### C) Intended semantics
Determine if the code intends:
- **latest** snapshot per asset,
- a short **time window** (e.g., last N minutes),
- or **full history** (unlikely to be needed frequently).

If latest per asset is intended, change query to return 1 row per asset (e.g., Postgres `DISTINCT ON (assetId) ... ORDER BY assetId, timestamp DESC` or ORM equivalent).

### D) Potential amplifiers
Check for:
- N+1 query patterns (calling the snapshot query once per asset instead of batching once)
- repeated calls with same assetId list without caching
- missing caching layer (Redis TTL cache for prices could reduce DB load dramatically)
- oversized asset lists called too frequently

---

## Commands already used (for reference / reproducibility)

### Container and system checks
```bash
docker compose ps
docker stats --no-stream
docker inspect polymarket-worker --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}'
docker logs --since 2h --tail 200 polymarket-worker
docker system df
df -h
df -ih
```

### Kernel log for OOM
```bash
sudo journalctl -k -b -1 --no-pager | egrep -i "oom|out of memory|killed process|hung task|I/O error|ext4|xfs" | tail -200
```

### Postgres “what’s running?”
```bash
docker exec -it polymarket-db psql -U copybot -c "
SELECT pid, now()-query_start AS age, state, wait_event_type, wait_event,
       left(regexp_replace(query, '\s+', ' ', 'g'), 300) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY age DESC;"
```

---

## Suggested next diagnostics (Codex can propose code changes based on these)
1. Run `EXPLAIN (ANALYZE, BUFFERS)` for the exact snapshot query to see if it’s doing seq scans and how many rows are returned.
2. Confirm table size and row counts:
   - `SELECT count(*) FROM "MarketPriceSnapshot";`
   - `SELECT pg_total_relation_size('public."MarketPriceSnapshot"');`
3. Add instrumentation in worker:
   - count how often snapshot queries run per minute
   - log duration and row count for snapshot fetches
4. Consider temporarily capping worker CPU in compose (`cpus: "1.0"`) to protect web latency while fixing the root cause.

---

## Success criteria (what “fixed” looks like)
- `docker stats` shows worker + db not constantly near full CPU.
- Postgres `pg_stat_activity` no longer shows many concurrent identical snapshot queries.
- Overall droplet CPU graph no longer pins at ~100% during normal operation.
- Delays / malfunctions improve (web remains responsive while worker runs).
