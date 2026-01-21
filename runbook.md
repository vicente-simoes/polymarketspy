# Local Development Runbook

## Infrastructure Management (Docker)

All commands assume you are in the project root directory.

### 1. Start Database & Redis
Start the services in detached mode (background).
```bash
docker compose -f docker/docker-compose.yml up -d
```

### 2. Stop Infrastructure
Stop the running containers without deleting data.
```bash
docker compose -f docker/docker-compose.yml stop
```

### 3. Reset Database (Wipe All Data)
**WARNING**: This will permanently delete all data in Postgres and Redis.

1.  **Destroy containers and volumes**:
    ```bash
    docker compose -f docker/docker-compose.yml down -v
    ```

2.  **Start fresh containers**:
    ```bash
    docker compose -f docker/docker-compose.yml up -d
    ```

3.  **Re-apply database schema**:
    *Note: Since the `.env` file points to `db:5432` (for Docker), we must explicitly point to `localhost` when running migrations from your terminal.*
    ```bash
    DATABASE_URL="postgresql://copybot:sF4VgGVbSIkruI2UoMwPHTaFVVqgUWMK@localhost:5432/copybot?schema=public" pnpm prisma:migrate
    ```

### 4. View Logs
Follow the logs of the database and redis containers.
```bash
docker compose -f docker/docker-compose.yml logs -f
```



Local Development (recommended workflow):
  # Start db + redis in Docker
  docker compose -f docker/docker-compose.dev.yml up -d

  # Run web + worker natively with hot reload
  pnpm dev

  Full Stack Local Testing (test Docker builds):
  docker compose -f docker/docker-compose.local.yml up --build
  # Access: http://localhost

  Production Deployment (on droplet):
  # Create .env with real secrets, then:
  docker compose -f docker/docker-compose.yml up -d --build


ssh polybot@165.22.205.182

pass:polymarket-bot

pass (inside): jocavice

docker exec -it polymarket-db psql -U copybot -d copybot -c \
"INSERT INTO \"AllowedAdminEmail\" (\"id\",\"email\")
 VALUES (gen_random_uuid(), 'vicente.pt.simoes@gmail.com')
 ON CONFLICT (\"email\") DO NOTHING;"



cd ~/apps/polymarketspy/docker

# stop everything
docker compose down

# delete the postgres data volume (THIS DELETES ALL DB DATA)
docker volume rm docker_pgdata

# bring db back up
docker compose up -d db

# run migrations (pick ONE of these options)
# 1) if you have migration files in /app/prisma/migrations:
docker compose run --rm worker sh -lc 'cd /app && npx prisma migrate deploy'

# OR 2) if you DON'T have migrations and just want schema pushed:
# docker compose run --rm worker sh -lc 'cd /app && npx prisma db push'

# start the rest
docker compose up -d