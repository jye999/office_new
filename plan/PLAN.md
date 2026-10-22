# Office rebuild: Laravel 5.4 (PHP) → TypeScript

Source (read-only): `~/code/office`. Target: `~/code/office_new`.

## Goals and non-goals

- **Same pages, same behaviour.** Every routed page renders the same HTML, at the same URL, with the same CSS and JS assets. Every AJAX endpoint returns the same JSON shape. Users should not notice the switch except for having to log in once.
- **Same database.** No schema changes. The app reads and writes the existing MySQL `office` database (table prefix `os_`) and the `hwc` database. Users and roles stay in `os_users`, `os_roles`, `os_user_has_roles`; PDA tokens stay in `os_user_api_tokens`. Existing bcrypt `$2y$` password hashes keep working.
- **Out of scope:**
  - Wholesale / CubeCart / Presta / Saleor: `wholesaledb`, `prestawholesaledb`, `saleordb`, `cart` connections, the `Cube*`, `Presta*` and `SaleorProduct` models, `*Mover` libraries, the `Mover` command, and the `wholesale.categories` / `wholesale.copy` routes.
  - The log viewer (`/logs`) and `/queue-monitor` (vendor pages).
  - Controllers with no routes: `Funny`, `SupplierProductImage`, `Usps`, `Auth\AuthController`, `ApiLoginController`.
  - Views not reachable from a route.
  - Amazon **MWS** (`MarketplaceWebService*` classes): Amazon retired MWS in 2024. Port only what still runs through SP-API, and verify per call site.
- **No new features, no redesign.** Port behaviour as-is, quirks included. Record suspected bugs in `plan/NOTES.md`; do not fix them.

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 22, TypeScript (strict), pnpm | `tsx` for dev, `tsc --noEmit` for typecheck |
| HTTP | Fastify 5 | `ignoreTrailingSlash`, `@fastify/formbody`, `@fastify/multipart`, `@fastify/static` |
| Sessions / flash | `@fastify/secure-session` + `@fastify/flash` | Encrypted cookie, so no session store needed. Replaces Laravel session plus `$errors` / `old()` |
| Views | Nunjucks (`.njk`), one file per Blade view, same relative path | Blade → Nunjucks rules in `CONVENTIONS.md` |
| DB | Kysely + mysql2 (`dateStrings: true`) | Types generated from the live DB with `kysely-codegen`. Two instances: `db` (office) and `hwc` |
| Validation | zod | Only where Laravel validated (`$this->validate`, Request classes) |
| Jobs / cron | BullMQ on the existing Redis | Mirrors `app/Console/Kernel.php`. **Disabled unless `SCHEDULER_ENABLED=1`** so it never double-runs alongside the PHP cron |
| Real-time | `pusher` npm package | Same app, channels and event names |
| HTTP clients | native `fetch`; `soap` for Stamps (reuses the WSDL files) | |
| Files | `sharp` (Intervention), `exceljs` (maatwebsite/excel), `@aws-sdk/client-s3`, `ssh2-sftp-client`, `nodemailer` | |
| PDF | decided per task; replicate whatever the PHP code produced | |
| Tests | vitest (unit) + `scripts/parity.ts` (old vs new HTML/JSON diff) | |

The frontend is **not rebuilt.** The new app serves the old `public/` directory as-is, including the compiled Vue 2 bundle `public/js/app.js`, all CSS, images and uploads. During coexistence, `PUBLIC_DIR` points at `~/code/office/public`, so both apps share uploads.

## Coexistence and verification

- The old app runs in Docker on port **6999** (see `~/code/office/docker-run-readme.md`). The new app runs on port **7000**. Both use the same MySQL (`127.0.0.1:3306`) and Redis.
- `scripts/parity.ts` logs into both apps as the same user, requests a list of URLs, normalizes the responses, and diffs them. HTML: collapse whitespace, strip CSRF tokens and timestamps. JSON: deep-compare the parsed values. **A task is done only when parity passes for its safe GET routes.**
- **Safety rules for every task:**
  - **Never** call an endpoint that buys postage (`buyLabel`, `buyMultiLabel`, `frayunBuyLabel`, `fedex.getLabel`, `ups.getLabel`, `GetAmazonShippingLabel`, …).
  - **Never** call an endpoint that uploads tracking, or that writes to eBay, Amazon, Shopify, Etsy, Walmart or Wayfair.
  - **Never** call an endpoint that sends email.
  - Mutating routes (POST/PUT/DELETE, or `any` routes that write) are verified by code review plus the manual checklist the task writes. They are not parity-tested against the live DB.

## Phases and tasks

Each task is a file in `plan/tasks/`. Tasks run **one at a time** (single llama-server slot, one writer). Progress is tracked in `plan/STATUS.md`.

| Phase | Tasks | Gate |
|---|---|---|
| 0. Foundation | T00 scaffold+db · T01 views+layouts · T02 auth+roles · T03 router+parity harness · T04 shared helpers | Human/Opus review before Phase 1 |
| 1. Simple modules | T10–T23 | parity on each module's GET routes |
| 2. Core inventory | T24 PDA API · T25a/b Inventory · T26–T28 Product · T30 Supplier/Images | parity; PDA covered by JSON tests |
| 3. Integrations | L01–L12 (libraries, no routes) then T40–T44 (carrier and marketplace controllers) | unit tests with mocked HTTP |
| 4. Unshipped | U1–U10 | parity on listing pages |
| 5. Jobs | J1 scheduler+queue · J2–J6 sync actions | dry-run mode per action |
| 6. Cutover | C1 full parity sweep · C2 deploy | switch DNS/port, disable PHP cron |

See `plan/tasks/INDEX.md` for the full ordered list with dependencies.

## How a task runs

1. The agent reads `plan/CONVENTIONS.md`, then its task file, then the PHP sources and Blade views the task lists, using the method line ranges given.
2. It writes TS route handlers in `src/modules/<module>/` and Nunjucks views in `views/`, then registers the routes.
3. It runs `pnpm typecheck` and `pnpm test`, plus `pnpm parity --task <ID>` when the task has safe GET routes.
4. It appends a short entry to `plan/STATUS.md` (done / partial / blocked, what's untested) and logs quirks in `plan/NOTES.md`.
