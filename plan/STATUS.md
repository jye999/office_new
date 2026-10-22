# Status

One entry per task: `## <ID> — done|partial|blocked`, files, verified, not verified, manual checklist.

## T00 — done
Worker (Qwen) timed out at 30 min while running its final verification; finished and verified by Opus.
- Files: package.json, tsconfig.json, .env.example (.env gitignored), src/config.ts (zod env), src/db.ts (db + hwc Kysely, dateStrings, nowDb), src/db/office.d.ts + hwc.d.ts (kysely-codegen), src/server.ts, test/nowDb.test.ts.
- Fixed: /__health used `selectNoFrom([sql...])` (TS2769) → `sql\`select 1 as one\`.execute(db)`.
- Verified: `pnpm typecheck` OK; `pnpm test` 2/2 pass; server on :7000 → `/__health` = {"ok":true,"db":1}; `/favicon.ico` 200; `/js/app.js` 200.
- Not verified: nothing outstanding for T00.

## T01 — done
View engine + Blade globals + shared layouts.
- Files: src/view.ts (nunjucks env, PHP-mimicking globals, MessageBag, FormBuilder, buildContext, render, registerViewPlugins), src/lang/en.ts (auth/pagination/passwords/validation), src/router.ts (stub, T03 owns), src/auth.ts (stub, T02 owns), src/server.ts (plugins + /__layout-test), views/ (layout.njk, unshipped_layout.njk, includes/, notifications.njk, massPrint.njk, layouts/, partial/, error(s)/, scaffold-interface/layouts/, layout-test.njk), test/view-helpers.test.ts, test/form.test.ts, test/render.test.ts.
- Key decisions:
  - layout.njk inlines the `<head>` markup so child {% block %} overrides work (nunjucks does not let child blocks reach blocks inside {% include %}). includes/header.njk kept for unshipped_layout (no child overrides its blocks).
  - nunjucks forbids duplicate block names and self.<block>() is broken in nunjucks 3.2.4 (verified empirically): header's second @yield('description'/'author') (DC.subject/DC.creator) became separate dc_subject/dc_creator blocks, empty by default. Only admin/blogs/index sets description — the T05 task should also set dc_subject there.
  - session()/old() are non-consuming reads (Laravel Session::get); @fastify/flash stores data at session['flash'] ({type: [msgs]}), consumed via reply.flash() in redirect flows.
  - Form::/csrf_field() output needs `| safe` in templates (nunjucks autoescapes {{ }}; Blade returned HtmlString).
- PHP-parity quirks kept: nl2br('a\r\nb') = 'a<br /><br />\nb' (PHP's \n pass re-processes step-1 output); url() query uses http_build_query encoding (space=+); json_encode escapes / and non-ASCII; round/number_format are half-away-from-zero (toPrecision(15) denoise; ulp drift possible on exact half-edges like 0.145).
- Verified: pnpm typecheck clean; pnpm test 27/27 (globals vs known PHP output, FormBuilder HTML exactness incl. attribute order + PUT spoofing, MessageBag, layout-test render integration via fastify inject); server on :7000 → GET /__layout-test = 200, 20.6 KB, title override + all globals render.
- Not verified: unshipped_layout.njk and massPrint.njk were converted from Blade by script + hand-fix and are not rendered end-to-end (they only render once their pages are ported, T04+).
- Manual checklist (when first page body lands): spot-check one page's Form:: fields against a screenshot of the old app; confirm dc_subject is acceptable to remain empty on non-blog pages.

## T02 — partial
Worker (Qwen) timed out at 2h while starting its end-to-end login check; code finished and committed by supervisor.
- Files: src/auth.ts (session, currentUser, roles, guards, PDA api-key), src/http.ts, src/modules/auth/routes.ts, src/modules/api/routes.ts, views/auth/*, views/home.njk, test/auth.test.ts.
- Verified (supervisor): typecheck OK; 39/39 tests pass; DB has no leftover temp user/token rows.
- Not verified: real login against :7000 with a live account, `auth:api` (Passport token) compatibility with the existing Vue bundle, password-reset flow. Re-check when T03's parity harness can log in.

## T03 — done
Router helpers + parity harness.
- Files: src/router.ts (rewrote T01 stub: `route()`, `any()`, `resource()`, named-route table + `routeUrl()` (Laravel `{x}` and fastify `:x` placeholders, extras -> query), `_method` spoofing (PUT/PATCH/DELETE routes get a POST shim; plain POST -> 405), `registerFallback()` + `installRouter()` not-found handler replicating the 5 regex catch-alls in web.php order with their role guards, Symfony 404 page); src/http.ts (+`lredirect()` 302 with Laravel's "Redirecting to X" HTML body + absolute Location, `redirectBack()` now uses it, +`paginate()` 5.4 LengthAwarePaginator JSON — no first_page_url/links, negative `from` when total=0); scripts/parity.ts (login both apps, per-URL status/Location/body compare, HTML normalization incl. debugbar strip, JSON deep-equal, 80-line unified diff, outputs to .parity/); plan/RUNBOOK.md; plan/NOTES.md (+2 entries); test/router.test.ts (12 new tests); src/server.ts (installRouter before routes; formbody/multipart wrapped in `fp()` for global scope).
- Verified: `pnpm typecheck` clean; `pnpm test` 51/51; `pnpm parity --urls /home,/login` -> `OK /home (200)`, `OK /login (302)`, `all 2 pass` (old app started per RUNBOOK on :6999, new app on :7000; temp parity user created for login and deleted afterwards, no DB leftovers; :7000 stopped, :6999 left running for later tasks' parity).
- Not verified: catch-all dispatch with a registered handler (T26/T30 — until then 404, as designed); 403 "No Access." on catch-alls for logged-in users without the role (only anon -> /login inject-tested); 404 body byte-parity (old app has APP_DEBUG=true -> Symfony debug page with PHP traces, not reproducible; new app serves the production Symfony 404 page — plan/NOTES.md); `pnpm parity --task <ID>` mode (only --urls exercised); login POST body parity (form POST now works — see below — but is not a GET route).
- Cross-module changes (minimal, backward-compatible, called out per convention): Laravel 302s carry an HTML body + absolute Location, so `reply.redirect()` call sites in src/auth.ts (guards), src/server.ts and src/modules/auth/routes.ts (T02) were switched to `lredirect()`; 3 T02 test assertions now expect absolute Location. Also fixed a T02 latent bug: formbody was registered encapsulated, so root-level urlencoded POSTs (real browser login forms) 415'd — now `fp(formbody)`/`fp(multipart)` global scope.
- Note: the automated stale-finding on plan/gen_tasks.py was re-run and passes (58 tasks written); no change needed.
- Manual checklist (T10+): run `pnpm parity --task T10` to exercise `--task` mode on real pages; confirm a supplier-role user gets 403 `No Access.` on `/ListProducts`.
