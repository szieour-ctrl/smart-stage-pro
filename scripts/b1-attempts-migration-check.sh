#!/usr/bin/env bash
# Applies the PROPOSED attempt-log migration (20261108) to a THROWAWAY local PostgreSQL cluster (never a hosted project) on top of the repo's
# Agent Marketing migrations and the Stage B ledger + evidence migrations, runs scripts/b1-attempts-migration-check.sql, applies the rollback,
# re-applies it, and deletes the cluster.
# Needs a local PostgreSQL (initdb, pg_ctl, psql). Usage: scripts/b1-attempts-migration-check.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DIR="$(mktemp -d)"; PORT="${PG_PORT:-55432}"
AS=(); if [ "$(id -u)" = 0 ]; then AS=(runuser -u postgres --); chown postgres "$DIR"; fi
cleanup() { "${AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
"${AS[@]}" "$BIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"${AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
P=("${AS[@]}" "$BIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -tA)
"${P[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table public.users (id uuid primary key); create table public.marketing_profiles (user_id uuid primary key); create table public.reel_jobs (id uuid primary key);"
for m in 20261022_agent_marketing_foundation 20261024_agent_marketing_research; do "${P[@]}" -f "$ROOT/supabase/migrations/$m.sql"; done
LEDGER="$ROOT/docs/proposed-migrations/20261101_agent_marketing_provider_request_reservation.up.sql"   # R11 dependency, applied first
"${P[@]}" -c "set client_min_messages=warning" -f "$LEDGER"
EVID="$ROOT/docs/proposed-migrations/20261105_agent_marketing_article_evidence.up.sql"
"${P[@]}" -c "set client_min_messages=warning" -f "$EVID"
UP="$ROOT/docs/proposed-migrations/20261108_agent_marketing_article_capture_attempts.up.sql"
DOWN="$ROOT/docs/proposed-migrations/20261108_agent_marketing_article_capture_attempts.down.sql"
"${P[@]}" -c "set client_min_messages=warning" -f "$UP" -f "$UP"; echo "PASS migration applies twice (idempotent)"
"${P[@]}" -f "$ROOT/scripts/b1-attempts-migration-check.sql" 2>&1 | grep -v "^$" | sed "s/^psql:[^ ]* NOTICE:  //"
"${P[@]}" -f "$DOWN"
"${P[@]}" -tAc "select to_regclass('public.agent_marketing_article_capture_attempts') is null" | grep -qx t
"${P[@]}" -tAc "select to_regclass('public.agent_marketing_article_evidence') is not null" | grep -qx t
echo "PASS rollback removes only the attempt log (the evidence table stays)"
"${P[@]}" -c "set client_min_messages=warning" -f "$UP"; echo "PASS migration re-applies after rollback"
