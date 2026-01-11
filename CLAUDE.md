# Polymarket Copybot (v0) — Claude Code Instructions (SOURCE OF TRUTH FOR THE CODING AGENT)

This repository builds a **paper-trading** copy-trading bot + dashboard for Polymarket.

**Hard constraints (non-negotiable):**
- v0 is **paper trading only**. No signing. No custody. No real orders. Ever.
- Implementation must match `planning.md` and `stepbystep.md` exactly. If a requested change conflicts with those docs, flag it and propose a doc update first.
- **No floats** for money or price. Store and compute using integer micros (USDC 6dp; probability price 0..1_000_000).
- All ingestion + ledger logic must be **idempotent** (safe to retry/restart without duplicates).
- The system must run on a **single DO $12 droplet**: avoid heavy recompute; rely on snapshots.

---

## Quick repo map (monorepo)

```
/apps
  /web            Next.js dashboard (Tailwind + shadcn/ui + Recharts + NextAuth)
  /worker         TS worker (BullMQ + Redis + Prisma) — ingestion + simulation engine
/packages
  /shared         Shared types, config schemas, reason codes
/prisma
  schema.prisma   DB schema (Prisma)
/docker
  docker-compose.yml
  Dockerfile.web
  Dockerfile.worker
  nginx.conf
  redis.conf
planning.md       v0 implementation spec (LOCKED)
stepbystep.md     step-by-step build guide (LOCKED)
```

---

## “Do this first” workflow for every task

1) **Read** `planning.md` + relevant sections of `stepbystep.md`.
2) **Explore** the codebase for existing patterns and file locations.
3) Write a short plan:
   - which files will change
   - what DB migrations are needed (if any)
   - what commands you’ll run to validate
4) Implement in small commits.
5) Run validation commands (see below).
6) Update docs **only if** the implementation meaningfully changes behavior.

---

## Dev commands (canonical)

### Install + build
```bash
pnpm install
pnpm -r typecheck
pnpm -r lint
pnpm -r build
```

### Prisma
```bash
pnpm prisma generate
pnpm prisma migrate dev        # local dev
pnpm prisma migrate deploy     # production
pnpm prisma studio
```

### Docker
```bash
docker compose -f docker/docker-compose.yml up --build
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f worker
docker compose -f docker/docker-compose.yml ps
```

### Health checks
- Web: `GET /api/health`
- Worker: `GET /health` (internal)

---

## Architecture rules (must follow)

### Services
- Postgres = source of truth
- Redis = BullMQ queues (not source of truth)
- Worker = ingestion + simulation + snapshots
- Web = dashboard + config writing (never holds secrets)

### Data sources
- Canonical fills/events: **Polymarket Data API** (polling is OK)
- Low-latency trigger: **Alchemy WS logs** (non-canonical; used only to prompt reconcile)
- Order book + marks: Polymarket CLOB endpoints (event-driven book fetch)

### Queues (exact names, do not rename)
- `q_ingest_events`
- `q_group_events`
- `q_copy_attempt_user`
- `q_copy_attempt_global`
- `q_portfolio_apply`
- `q_reconcile`
- `q_prices`

### Portfolio scopes (exact)
- `SHADOW_USER`
- `EXEC_USER`
- `EXEC_GLOBAL`

### Copy behavior
- Copy BUY/SELL + MERGE/SPLIT when applicable.
- Notional sizing = **1% of their notional** by default, clamped (see `planning.md`).
- Partial fills: allowed; 0% fill becomes SKIP with reason.

### Guardrails defaults
Do not change default guardrails unless explicitly requested; they are locked in `planning.md`.

---

## Database + money handling rules

- Store prices as `priceMicros` (0..1_000_000).
- Store USDC as `*_Micros` integers (6 decimals).
- Store shares as `shareMicros` (BigInt).
- Never store float in DB.
- Prefer append-only tables:
  - Canonical events immutable
  - Ledger entries append-only
  - Snapshots are derived and can be recomputed

Idempotency:
- Inserts must be upserts using the unique constraints described in `planning.md`.
- Every ledger application must be protected by uniqueness: `(portfolioScope, refId, entryType)`.

---

## Web security rules (v0 built like v1)

- Only worker may ever hold trading credentials in v1 — keep the boundary now.
- Web API routes:
  - require NextAuth session
  - validate all write payloads with Zod
- Never log secrets.
- Never read `.env` in the repo during analysis; treat secrets as private runtime-only.

---

## Repository etiquette

- Make small, coherent commits with messages like:
  - `worker: ...`
  - `web: ...`
  - `db: ...`
  - `shared: ...`
  - `infra: ...`
- If a migration changes schema: include generated migration files in the commit.
- If you add a new queue/job: add it to System Status metrics and worker health output.

---

## What “done” looks like (must match planning.md acceptance criteria)

- Shadow(User) matches canonical events exactly (spot-check).
- Executable(User) and Global produce CopyAttempt rows with correct sizing + reason codes.
- Restart-safe: worker can be killed and restarted without duplicates.
- Dashboard pages exist and load fast (charts are based on snapshots, not recompute).

---

## Claude Code usage tips for this repo (use these defaults)

When asked to implement features:
- Prefer **reading files first**, then propose a plan, then implement.
- Always run:
  - `pnpm -r typecheck`
  - `pnpm -r build`
  - and any targeted commands needed (prisma migrate, docker build)
- If a task spans multiple components, implement in this order:
  1) DB + migrations
  2) worker ingestion/state
  3) worker simulation + ledger
  4) snapshots + pricing
  5) web API routes
  6) UI pages/charts

---

## “Do not do” list

- Do not implement real trading, signing, or wallet integrations in v0.
- Do not bypass guardrails.
- Do not introduce new architectural components not in `planning.md`.
- Do not add heavy runtime computation to web requests (use snapshots).
- Do not add file access to secrets; do not read `.env` or credentials files.

---

## Git permissions (explicit)
- Do NOT run `git commit`, `git push`, or any GitHub operations unless the user explicitly asks for it.
- Always show `git diff` and summarize changes before proposing a commit.


