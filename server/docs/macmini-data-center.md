# Mac mini Data Center

This document describes the main Bambook data service on the Mac mini. Secrets, API keys, Cloudflare tunnel tokens, and production `.env` values must stay on the machine and out of the repository.

## Services

| Service | Local Port | Public Route | Purpose |
|:---|:---|:---|:---|
| Main data API | `8081` | `https://jiangsupanda.com/bambook/api/*` | Orders, relations, products, product categories, insights, legacy knowledge sync, SSE |
| Knowledge API | `8091` | `https://jiangsupanda.com/bambook/kb/*` | Vector ingest/search, RAG debug context, optional chat (mount path `/bambook/kb`) |

Cloudflare should match `/bambook/api` before `/bambook`. The knowledge API also includes a fallback proxy for `/bambook/api/*` to `http://127.0.0.1:8081/api/*`, so the current single `/bambook` Cloudflare route can serve both APIs.

## Main Data API

Run from `apps/Bambook/server`:

```sh
npm install
npm run build
npm start
```

Required runtime dependencies:

- PostgreSQL reachable via `DATABASE_URL`
- `PORT=8081`
- `BAMBOOK_API_KEY` or `BAMBOOK_SDK_KEY` when `BAMBOOK_REQUIRE_AUTH=true`
- local `.env.local` or `.env` on the Mac mini only

On the Mac mini, the deployed main data API lives at `~/bambook-main-api` and runs via the user LaunchAgent `com.bambook.main-data-api`.

## Legacy Data Migration

The old SQLite source data is on the MacBook, not originally on the Mac mini. Copy it to the Mac mini import path and point `PO_DATABASE_PATH` there before running the migration:

```sh
rsync -az database/po_database.db panda1@PANDAdeMac-mini.local:~/bambook-main-api/import/po_database.db
```

Then run the server migration from `~/bambook-main-api` with the Mac mini `.env.local` loaded. Browser `localStorage` data should be pushed from the MacBook Bambook client using Settings -> Sync -> local cache migration.

## Health Checks

Local:

```sh
curl -sS http://127.0.0.1:8081/api/health
curl -sS http://127.0.0.1:8081/bambook/api/health
```

Public:

```sh
curl -sS https://jiangsupanda.com/bambook/api/health
curl -sS https://jiangsupanda.com/bambook/kb/health
```

## Client Settings

In Bambook Settings:

- Main data API endpoint: `https://jiangsupanda.com/bambook`
- Knowledge API endpoint: `https://jiangsupanda.com/bambook`
- Knowledge API key: stored locally by the user, sent as `Authorization: Bearer <API_KEY>`

The client appends `/api/...` for main data calls and calls knowledge endpoints directly relative to the knowledge base URL.
