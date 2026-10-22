# Porting conventions (read before every task)

You are porting a Laravel 5.4 app at `~/code/office` (READ-ONLY, never edit it) to TypeScript in `~/code/office_new`.
The prime directive: **same URL, same HTML, same JSON, same DB writes.** Port quirks faithfully. Do not refactor, rename,
redesign, or "improve" anything. If PHP code looks buggy, copy the behaviour and add a line to `plan/NOTES.md`.

## Where things are

| Old (PHP) | New (TS) |
|---|---|
| `routes/web.php`, `routes/api.php` | `src/modules/<module>/routes.ts` — one module per controller |
| `app/Http/Controllers/XController.php` | `src/modules/<x>/routes.ts` (+ `service.ts` if logic is long) |
| `resources/views/a/b.blade.php` | `views/a/b.njk` (same relative path, same name) |
| `app/Models/*.php` | no ORM. Query with Kysely: `db.selectFrom('os_products')` |
| `app/Libraries/X.php` | `src/lib/x.ts` |
| `app/Console/Commands/Runner.php` actions | `src/jobs/<area>.ts` |
| `public/` | untouched; served from `PUBLIC_DIR` |
| `plan/inventory.json` | every route: verb, path, controller, action, name, middleware, method line ranges, views |

Shared code (build in Phase 0; reuse, do not duplicate):

- `src/db.ts` — `db` (office DB) and `hwc` Kysely instances; `sql` re-export.
- `src/router.ts` — `route(app, {verb, path, name, roles, handler})`, `resource(...)`, `any(...)`; named-route table for `routeUrl()`.
- `src/auth.ts` — `currentUser(req)`, `hasRole(user, role)`, role guard, PDA api-key guard.
- `src/view.ts` — `render(reply, 'a/b', data)`; Nunjucks env with Blade helper globals.
- `src/http.ts` — `redirectBack`, `withErrors`, `withInput`, `jsonResponse` (Laravel-compatible).
- `src/datatables.ts` — yajra DataTables v6 server-side protocol.

## Database rules

- Laravel's `mysql` connection has prefix `os_`. **Query builder / Eloquent table `products` → Kysely `os_products`.**
  **Raw SQL strings (`DB::select("...")`, `DB::raw`) are NOT prefixed by Laravel — copy them unchanged.**
- Eloquent model → table: check the model's `$table`; else snake_case plural of the class name; then add `os_`.
  `protected $connection = 'hwc'` → use the `hwc` instance (prefix `''`).
- Eloquent `->timestamps`: on insert set `created_at` and `updated_at`, on update set `updated_at`
  (format `YYYY-MM-DD HH:mm:ss`, app timezone from `.env` `APP_TIMEZONE`, default as in `config/app.php`).
  Use `nowDb()` from `src/db.ts`.
- Relationships (`$product->locations`): write the explicit join/second query. Keep the same ordering the PHP produced
  (Eloquent default = no ORDER BY, i.e. insertion order; don't add ORDER BY that wasn't there).
- `->first()` → `.executeTakeFirst()`; `->firstOrFail()` / `findOrFail()` → 404 if missing; `->get()` → `.execute()`.
- `->paginate(n)` → use `paginate()` from `src/http.ts` (Laravel JSON shape).
- Wrap multi-statement writes in `db.transaction()` only if the PHP used `DB::transaction` / `beginTransaction`.

## JSON parity rules

- mysql2 is configured with `dateStrings: true` so dates come back as `'YYYY-MM-DD HH:mm:ss'` like Laravel. Do not
  convert them to `Date`.
- Ints are numbers, DECIMAL comes back as strings — same as Laravel 5.4 with native prepares. Don't coerce.
- Laravel serialising a model includes **all columns** except `$hidden` (User hides `password`, `remember_token`) plus
  `$appends`/accessors. Check the model for `$hidden`, `$appends`, `getXAttribute`, `$casts`.
- `return $array` / `return $model` / `response()->json(x)` → `reply.send(x)` (Fastify sends JSON).
- `return "string"` → `reply.type('text/html; charset=UTF-8').send(str)`.
- `return redirect('x')` → `reply.redirect(url('x'))` (302). `redirect()->back()` → `redirectBack(req, reply)`.
- `abort(404)` / `findOrFail` → 404 with the same body as Laravel's error page (`views/errors/404.njk`).

## Routing rules

- Paths are copied **exactly**, including odd ones like `/Wayfair.store` and `/products.data`.
- `Route::any` → GET, POST, PUT, PATCH, DELETE, OPTIONS (use `any()`).
- `Route::resource('x', ...)` → `resource()` helper: index, create, store, show, edit, update, destroy with Laravel names
  `x.index` … and `_method` form spoofing (POST + `_method=PUT|PATCH|DELETE`).
- Optional params `{id?}` → register both `/path` and `/path/:id`.
- Role groups come from `inventory.json` `middleware`. `role:a,b` → `roles: ['a','b']`.
  Not logged in → redirect `/login`; logged in without role → 403 body `No Access.`.
- The regex catch-alls (`/{Supplier?}`, `/{ListProducts?}`, …) are handled by the not-found fallback in `src/router.ts`
  in the original registration order. Don't register them as normal routes.
- Request input: Laravel `$request->input('x')` / `Input::get('x')` reads query **and** body. Use `input(req, 'x')`
  from `src/http.ts`. `$request->all()` → `allInput(req)`.

## Blade → Nunjucks

(In the table below `\|` is only markdown escaping. Write a plain `|` in templates.)

Output must be byte-for-byte the same HTML after whitespace normalization. Keep every tag, class, id, inline script
and comment. Translate only the Blade/PHP parts.

| Blade | Nunjucks |
|---|---|
| `@extends('layout')` | `{% extends "layout.njk" %}` (dots → slashes: `layouts.app` → `layouts/app.njk`) |
| `@section('x') … @stop` / `@endsection` | `{% block x %} … {% endblock %}` |
| `@section('title', 'Foo')` | `{% block title %}Foo{% endblock %}` |
| `@section('x') … @show` (in layout) | `{% block x %} … {% endblock %}` |
| `@yield('x')` / `@yield('x', 'def')` | `{% block x %}{% endblock %}` / `{% block x %}def{% endblock %}` |
| `@parent` | `{{ super() }}` |
| `@include('a.b')` / `@include('a.b', ['k'=>v])` | `{% include "a/b.njk" %}` / `{% set k = v %}{% include "a/b.njk" %}` |
| `{{ $x }}` | `{{ x }}` (autoescaped, same as Blade) |
| `{!! $x !!}` | `{{ x \| safe }}` |
| `@{{ vue }}` | `{% raw %}{{ vue }}{% endraw %}` |
| `$obj->prop` / `$arr['k']` | `obj.prop` / `arr.k` or `arr['k']` |
| `@if(...) @elseif @else @endif` | `{% if %} {% elif %} {% else %} {% endif %}` |
| `@foreach($xs as $x)` / `as $k => $v` | `{% for x in xs %}` / `{% for k, v in xs %}` |
| `$loop->index`, `$loop->first` | `loop.index0`, `loop.first` |
| `@forelse … @empty … @endforelse` | `{% for %} … {% else %} … {% endfor %}` |
| `isset($x)` / `empty($x)` | `isset(x)` / `phpEmpty(x)` globals (PHP semantics: `empty("0")` is true) |
| `@role(['a','b']) … @endrole` | `{% if hasRole(['a','b']) %} … {% endif %}` |
| `@php … @endphp`, `<?php … ?>` | compute it in the TS handler and pass it in; never inline JS logic for PHP side effects |
| `url('x')`, `URL::to('x')`, `asset('x')` | `url('x')`, `asset('x')` globals (absolute URLs like Laravel) |
| `route('name', [params])` | `route('name', params)` |
| `old('x', def)` | `old('x', def)` |
| `csrf_field()`, `csrf_token()` | `csrf_field()`, `csrf_token()` (emit the same markup; CSRF is not enforced) |
| `$errors->has('x')`, `$errors->first('x')`, `$errors->any()`, `$errors->all()` | `errors.has('x')`, `errors.first('x')`, … |
| `Session::get('x')`, `session('x')` | `session('x')` |
| `Auth::user()->name` | `auth.user.name` |
| `date('Y-m-d', $t)`, `number_format($n, 2)`, `substr`, `explode`, `implode`, `round`, `count`, `strtoupper`, `json_encode`, `in_array` | same-named globals in `src/view.ts` that mimic PHP exactly (`number_format(1234.5, 2)` → `1,234.50`) |
| `Form::open([...])`, `Form::text(...)`, `Form::select(...)`, `Form::close()`, `HTML::*` | globals in `src/view.ts` that emit the same HTML as laravelcollective/html 5.2 |
| `Lang::get('k')`, `trans('k')` | `trans('k')` reading `~/code/office/resources/lang/en/*.php` values ported to `src/lang/en.ts` |
| `config('app.name')` | `config('app.name')` |

If a view needs a PHP construct not in this table, add a helper to `src/view.ts` with a unit test, and note it in
`plan/STATUS.md` so later tasks reuse it.

## Definition of done (every task)

1. `pnpm typecheck` passes. `pnpm test` passes.
2. Every route in the task is registered (path, verb, name, roles exactly as in `inventory.json`).
3. Every view the task's routes render exists in `views/`.
4. `pnpm parity --task <ID>` passes for the task's **safe GET routes** (listed in the task file). If a GET route needs
   params, use a real id found in the DB (query it; read-only).
5. Mutating routes: write a manual test checklist in the task's section of `plan/STATUS.md`.
6. Do not touch files owned by other modules except to import shared helpers. If you must change a shared helper,
   keep it backward compatible and mention it in `plan/STATUS.md`.
7. Never call routes or library functions that buy postage, upload tracking, write to marketplaces, or send email.
8. Append to `plan/STATUS.md`: `## <ID> — done|partial|blocked`, files created, what was verified, what wasn't.
