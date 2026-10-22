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
