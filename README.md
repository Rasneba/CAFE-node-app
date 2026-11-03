# Restaurant Node App

Offline-first restaurant POS, kitchen display, ESC/POS printing, a public QR menu, and a
three-minute sync to Neon/Postgres on Vercel.

The reporting module (`src/reports/`) comes from PR #3 and exposes the Restaurant Sales
Report at `/api/reports/restaurant-sales` plus a CSV export.

## Requirements

- Node.js 22.5+ (built-in `node:sqlite` is used as the offline fallback)
- PostgreSQL 14+ for the shared database (Neon works)
- Optional: a network ESC/POS printer reachable over TCP 9100

## Quick start (local device)

```powershell
cd node-app
npm install
Copy-Item .env.example .env
# Edit .env: set DATABASE_URL (or leave empty for SQLite), DEVICE_API_KEY, CLOUD_URL
npm run setup
npm start
```

- POS / admin UI: http://localhost:4100/
- Kitchen display: http://localhost:4100/kitchen
- Public menu: http://localhost:4100/menu
- Health: http://localhost:4100/api/health

To use the SQLite fallback, set `DATABASE_URL=` (empty) in `.env` and run
`npm run setup` again. Data lives in `data/local.db`.

## Environment

| Variable | Purpose |
| --- | --- |
| `MODE` | `local` or `cloud` (auto-detected on Vercel) |
| `PORT` | Local server port (default `4100`) |
| `DATABASE_URL` | Postgres/Neon connection string; empty = SQLite |
| `SQLITE_FILE` | SQLite file when `DATABASE_URL` is empty |
| `DEVICE_ID` | Device name stored on synced orders |
| `DEVICE_API_KEY` | Shared secret for `/api/sync/push` and `/api/sync/pull` |
| `CLOUD_URL` | Public Vercel URL used by the local sync client |
| `SYNC_INTERVAL_MS` | Sync cadence, default `180000` (3 minutes) |
| `PRINTER_IP` / `PRINTER_PORT` | Network printer address (default TCP `9100`) |
| `PRINT_DRY_RUN` | `1` writes tickets to `logs/` instead of printing |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Basic auth for cloud admin and reports |
| `PUBLIC_URL` | Absolute URL used for QR menu links |

`config.json` (see `config.example.json`) is an optional alternative to environment
variables. Environment variables win.

## Cloud deploy (Vercel + Neon)

1. Create a Neon database and copy its pooled connection string.
2. Import the repository in Vercel and set **Root Directory** to `node-app`.
3. Add environment variables:
   - `DATABASE_URL`
   - `DEVICE_API_KEY` (same value as the local device)
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `PUBLIC_URL` (e.g. `https://your-app.vercel.app`)
4. Deploy. `api/index.js` runs the schema and demo seed on first request.
5. In Vercel **Settings → Deployment Protection**, disable Vercel Authentication for the
   public deployment, otherwise `/menu` and `/api/public/menu` return `401`/`302`.

Cloud routes:

- `/menu` public QR menu (`/api/public/menu?t=<qr_token>` for a table)
- `/admin` Basic-auth admin (menu editor, orders, QR, reports)
- `/api/sync/push` and `/api/sync/pull` device sync (`x-device-key`)
- `/api/reports/*` Basic-auth Restaurant Sales Report

## Sync

The local device calls `POST /api/sync/push` with unsynced orders and outbox entries,
then `GET /api/sync/pull?since=...` to refresh categories, items, tables and settings.
Orders are idempotent on `sync_id`; payments and items are linked to the cloud order
so reporting joins work. The loop starts automatically when `CLOUD_URL` and
`DEVICE_API_KEY` are set.

## Printing

`src/printer.js` sends ESC/POS bytes over TCP 9100 and retries failed jobs. With
`PRINT_DRY_RUN=1` the ticket payload is written to `logs/` instead, which is the safe
way to test locally. Use `/api/print/test` to verify the printer connection.

## Tests

```powershell
npm run check
npm test
```
