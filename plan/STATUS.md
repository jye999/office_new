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
