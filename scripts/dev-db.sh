#!/usr/bin/env bash
# A local Postgres for development, and the migrations applied to it.
#
# Supabase's free-tier session pooler allows 15 clients, which a couple of test
# runs can exhaust — and while it is exhausted the database is simply
# unreachable, which looks exactly like the API being broken. This removes that
# from the loop entirely: nothing here touches Supabase.
#
# ADR 0007 is what makes this possible. The database is plain Postgres with
# plain SQL and migrations the project owns, so any Postgres will do.
#
#   ./scripts/dev-db.sh          start it and migrate
#   ./scripts/dev-db.sh stop     stop and remove it
set -euo pipefail

NAME=stubby-dev-db
PORT=${STUBBY_DB_PORT:-55432}
URL="postgresql://postgres:postgres@localhost:${PORT}/stubby?sslmode=disable"

if [ "${1:-start}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "stopped $NAME"
  exit 0
fi

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  docker run -d --name "$NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=stubby \
    -p "${PORT}:5432" \
    --health-cmd pg_isready --health-interval 3s \
    postgres:18-alpine >/dev/null
  echo "started $NAME on port $PORT"
else
  docker start "$NAME" >/dev/null 2>&1 || true
  echo "$NAME already exists; started it"
fi

printf 'waiting for postgres'
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)" = healthy ]; do
  printf '.'
  sleep 2
done
echo ' ready'

DATABASE_URL="$URL" pnpm --filter @stubby/api migrate

cat <<NOTE

Database is up. Start the API and the app in two terminals:

  DATABASE_URL='$URL' pnpm --filter @stubby/api start
  pnpm --filter @stubby/app web

(Use the pnpm script, not \`node dist/server.js\` — the script loads .env, and
without it the API exits with \"SIWE_DOMAIN is not set\".)

Then open http://localhost:8081
NOTE
