# Runbook: old + new apps side by side

## Containers already running (shared)

- `mysql` — MySQL 8 on 127.0.0.1:3306 (network `stack_default`)
- `redis` — Redis on 127.0.0.1:6379 (network `stack_default`)

## Old app (PHP, port 6999)

From `~/code/office/docker-run-readme.md`, adjusted to run detached. The repo's
`.env` already points at the docker hosts (`DB_HOST=mysql`, `REDIS_HOST=redis`),
so no `.env` edits are needed (the source tree stays read-only).

```bash
docker rm -f office 2>/dev/null
docker run -d --name office --network stack_default -p 6999:6999 \
  -v /home/johnny/code/office:/app -w /app php:7.4-cli bash -lc '
    set -e
    printf "%s\n" \
      "deb http://archive.debian.org/debian bullseye main" \
      "deb http://archive.debian.org/debian bullseye-updates main" \
      "deb http://snapshot.debian.org/archive/debian-security/20260831T000000Z bullseye-security main" \
      > /etc/apt/sources.list
    echo "Acquire::Check-Valid-Until \"false\";" > /etc/apt/apt.conf.d/99no-check-valid-until
    rm -rf /var/lib/apt/lists/*
    apt-get update &&
    apt-get install -y git unzip libzip-dev libpng-dev libonig-dev libxml2-dev nodejs npm &&
    docker-php-ext-install pdo_mysql zip gd mbstring soap &&
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer &&
    composer install --no-interaction || composer install --no-interaction --ignore-platform-reqs
    npm install || true
    npm run dev || true
    chmod -R 775 storage bootstrap/cache
    php artisan serve --host=0.0.0.0 --port=6999
  '
```

First build takes a few minutes (apt + composer + npm/mix). Watch with
`docker logs -f office`; it is ready when `curl -s -o /dev/null -w '%{http_code}' http://localhost:6999/login`
returns `200`. Stop: `docker stop office` (do this before finishing a task —
the T03 convention is not to leave extra servers around, but the old app on
6999 is needed for `pnpm parity`).

Notes:

- `APP_DEBUG=true` in the old `.env`, so the old app's 404/500 pages are
  Symfony's *debug* exception pages (PHP traces, request details). The new app
  emits the production (non-debug) Symfony 404 page — see plan/NOTES.md.
  Parity is not asserted on 404 bodies.
- `npm run dev` (mix build) may fail on the old webpack chain; it is `|| true`
  because the compiled `public/` assets are already built and shared.

## New app (Fastify, port 7000)

```bash
cd ~/code/office_new
pnpm dev          # or: pnpm start
```

Health: `curl -s http://localhost:7000/__health` → `{"ok":true,"db":1}`.
Always stop it before finishing a task; never leave :7000 listening.

## Parity

```bash
cd ~/code/office_new
pnpm parity --task T10        # URLs from plan/parity-routes.json
pnpm parity --urls /home,/login
```

Needs `PARITY_EMAIL` / `PARITY_PASSWORD` in `office_new/.env`, both apps up.
Full per-URL outputs land in `.parity/<task>/`.

---

# Cutover (C1): PHP app -> office_new

Prerequisite: `pnpm typecheck && pnpm test && pnpm routes:check` green, `pnpm parity` re-run over `plan/parity-routes.json`
with the failures in `plan/STATUS.md` (`## C1`) triaged. No build step: the app runs TypeScript through `tsx`
(Node 22, pnpm). "Build" = install + typecheck.

## Build

```bash
cd ~/code/office_new
pnpm install --frozen-lockfile
pnpm typecheck
```

## Processes

| Process | Command | Notes |
|---|---|---|
| web | `pnpm start` (`tsx src/server.ts`) | Fastify on `PORT`. With `SCHEDULER_ENABLED=1` it also upserts the 24 BullMQ cron schedulers (idempotent) at boot. |
| worker | `pnpm worker` (`tsx src/jobs/worker.ts`) | BullMQ worker on queue `jobs`, prefix `office_new`. Runs the cron `sync <action>` jobs and the label/ping jobs. Needs Redis; handles SIGTERM. |

Both must run for scheduled sync + queued jobs; the web alone serves pages. Example systemd units
(`/etc/systemd/system/office-new-web.service`, `office-new-worker.service`; adjust `User`, node path):

```ini
[Unit]
Description=office_new web
After=network.target mysql.service redis.service

[Service]
User=johnny
WorkingDirectory=/home/johnny/code/office_new
EnvironmentFile=/home/johnny/code/office_new/.env
ExecStart=/usr/bin/env pnpm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The worker unit is identical except `Description=office_new worker`, `ExecStart=/usr/bin/env pnpm worker` and
`After=redis.service`. Do not put `SCHEDULER_ENABLED=1` in `.env` until step 2 below.

## Env checklist (`~/code/office_new/.env`; see `.env.example`)

- [ ] `PORT`, `APP_URL` (public URL; used by `url()`/`asset()` and `OLD_APP_URL` only by the parity harness)
- [ ] `APP_KEY` (64 hex; changing it logs everyone out), `APP_TIMEZONE` (cron schedules + `nowDb()`), `APP_ENV`
- [ ] `DB_HOST/PORT/DATABASE/USERNAME/PASSWORD`, `DB_HWC_DATABASE` (same DBs as the PHP app; no schema changes)
- [ ] `REDIS_HOST`, `REDIS_PORT` (same Redis as PHP). BullMQ keys live under the fixed prefix `office_new:*`
      (queue `office_new:jobs`) and never touch Laravel's `queues:*` keys
- [ ] `PUBLIC_DIR` and `STORAGE_DIR` point at the live app's `public/` and `storage/` (uploads/labels are shared)
- [ ] `SCHEDULER_ENABLED` : `0` until step 2, then `1` on the **web** unit only (worker does not need it)
- [ ] `DRY_RUN` : empty/`0` for live. `DRY_RUN=1` skips every carrier purchase, tracking upload, marketplace write and
      `pnpm sync` DB write (use it for rehearsal on a staging DB or the first worker run)
- [ ] `MAIL_ENABLED` : `0` (default) logs mails instead of sending; set `1` with `MAIL_HOST/PORT/USERNAME/PASSWORD`
      only when a real send is intended (the sales-tax email report and eBay failure mails use it)
- [ ] Marketplace/carrier credentials as in `.env.example` (AMZ_*, EBAY_*, RAYSTORE_*, ETSY_*, SHOPIFY_*, WALMART_*,
      HOUZZ_*, WAYFAIR_*, STAMPS_*, FEDEX_*, UPS_*, FRAYUN_*, USPS_*), `PUSHER_*`, `AWS_*`, `OPENAI_*`, `N8N_MCP_URL`
- [ ] `PARITY_EMAIL/PASSWORD` are only needed on the machine that runs `pnpm parity`

## Steps

1. **Pre-flight (PHP still live).** Start web + worker with `SCHEDULER_ENABLED=0` on a spare port. Run
   `pnpm routes:check`, `pnpm parity --task <ID>` for every task, and the smoke checklist below read-only.
2. **Stop the PHP scheduler and queue.** Remove/disable the `* * * * * php artisan schedule:run` crontab line and
   stop every `php artisan queue:work` process/supervisor. Wait for in-flight runs to finish
   (`ps aux | grep artisan`). From here nothing may run both schedulers: the PHP cron and `SCHEDULER_ENABLED=1`
   must never be on at the same time (double marketplace uploads / label buys).
3. **Enable the new scheduler.** Set `SCHEDULER_ENABLED=1` in `.env`, then
   `sudo systemctl restart office-new-web` and `sudo systemctl start office-new-worker`.
   Check Redis only for `office_new:*` keys (`redis-cli --scan --pattern 'office_new:*' | head`) and the worker log for
   `job ... failed`. Do this before step 4 so the first scheduled tick is the new app's.
4. **Switch traffic.** Either give the new app the production port (stop the PHP server, set `PORT`, restart web), or
   change the reverse-proxy upstream from the PHP port to `PORT` (`nginx -t && systemctl reload nginx`). Everyone logs in
   once (sessions are a new encrypted cookie; passwords/`$2y$` hashes unchanged).
5. **Smoke test** (as admin, then a `supplier`/`remote` user):
   - [ ] `/__health` -> `{"ok":true,"db":1}`; `/login` page + login/logout; `/home`
   - [ ] Static assets 200: `/js/app.js`, `/css/app.css`, one `/storage/...` image
   - [ ] Pages render: `/summary`, `/allunshipped`, `/unshipped1`, `/product`, `/inventory`, `/Production`, `/Purchase`,
         `/FollowUps`, `/SupplierProduct`, `/queue`, `/actionLogs`
   - [ ] Role guards: anonymous -> 302 `/login`; wrong role -> 403 `No Access.`
   - [ ] PDA: `GET /api/pda/sku` with a PDA api key returns JSON
   - [ ] Jobs: open `/queue`, hit `/queue.ping`, confirm the worker adds the `os_queuejobs` ping row
   - [ ] First scheduled tick: check the worker log and `os_report_time`/order tables after the next `* * * * *` action;
         if unsure start with `DRY_RUN=1` for one cycle and watch the `[DRY_RUN] ... skipped` lines
   - [ ] Do NOT click: Buy Label, Mass Print, tracking upload, Create Scan Form, anything that emails
6. **Rollback** (keep the PHP app installed and its `.env` untouched until sign-off):
   1. Set `SCHEDULER_ENABLED=0`, `systemctl stop office-new-worker office-new-web`
      (optionally `redis-cli --scan --pattern 'office_new:*' | xargs -r redis-cli del` to drop pending new-app jobs).
   2. Point the proxy/port back at the PHP app; confirm `/login` 200.
   3. Re-enable the `schedule:run` crontab line and the `queue:work` supervisor.
   4. Review `os_queuejobs`, `os_orders`/`os_trackings` rows written since cutover for duplicates before the PHP cron
      re-uploads tracking.

## Known residual risks (from plan/STATUS.md)

- **Label/download jobs are dry-run stubs.** The queue handlers for `MassPrintLabel`, `AmzMassPrintLabel`,
  `FrayunMassPrintLabel` and `DownloadLabel` only log `carrier purchase stubbed` / `download stubbed` (J1); mass label
  printing via the queue does not actually buy or download labels. `QueuePing` is real.
- **Faire image import is forced dry-run.** `pnpm faire:import-images` parses and plans but never downloads or replaces
  files or DB rows.
- **Live integrations are unverified.** Every marketplace/carrier path (Amazon SP-API, eBay, Walmart, Shopify, Etsy,
  Houzz, Wayfair, Stamps, FedEx, UPS, Frayun, S3/SFTP, Pusher, OpenAI/MCP, real SMTP) was tested only against stubbed
  transports; no live write, tracking upload, purchase or mail was ever exercised. Compare the first live runs with the
  old app's logs before relying on them.
- **Retired/absent pieces kept as in PHP:** Amazon MWS feed upload (`/UploadTracking`, `update-amz-shipped`) is not
  ported (500 / no-op); the `SalesReport` stored procedure and several `hwc` tables are missing in the shared snapshot,
  so `email-sales-report` and `windy`/`mermaid` fail exactly as the old app does there.
- **Sync actions with real writes** (`windy`, `mermaid`, `stats`, `shopify-products` truncate+refill, `get-walmart-items`
  truncate+insert) were only EXPLAIN/stub-verified. Run each once with a DB backup before leaving them scheduled.
- **404/500 pages differ** from the old APP_DEBUG Symfony debug pages (production-style pages in the new app).
- **Unowned api routes:** `POST /api/login`, `/api/register`, `/api/password/email`, `/api/password/reset` are in
  `routes/api.php` but not registered (see `pnpm routes:check`).
