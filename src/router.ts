// T03 router: Laravel-compatible route registration, named-route table,
// `_method` form spoofing, and the not-found fallback that replicates the old
// app's regex catch-alls (routes/web.php) before defaulting to Laravel's 404.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
import { currentUser, hasRole, passportApiAuth, pdaAuth, requireLogin, requireRoles } from './auth.js';
import { input, lredirect } from './http.js';

// 'options' is internal (part of 'any'); callers pass the six verbs below.
export type RouteVerb = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'any' | 'options';
export type RouteHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

// ---------------------------------------------------------------- named routes

// name -> Laravel-style path template, e.g. 'products.show' -> '/products/{id}'.
export const routeTable: Record<string, string> = {};

export function registerRoute(name: string, path: string): void {
  routeTable[name] = path;
}

export function isRegisteredRoute(name: string): name is string {
  return name in routeTable;
}

// T10: shared layouts (includes/nav) call route() for every module's named
// routes. So that route() emits the same URL as the old app before each module
// task registers its route, pre-load the table from the static route inventory.
// Modules' own registerRoute() calls overwrite these entries at startup.
export function preloadRouteTable(): void {
  let inv: { routes?: { name?: string | null; path?: string | null }[] };
  try {
    inv = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plan', 'inventory.json'), 'utf8'));
  } catch {
    return; // no inventory (unit tests) — modules register their own names
  }
  // Laravel's Route::resource entries carry no `as` name in routes/web.php, so the
  // inventory has none; synthesize the `<base>.<action>` names Laravel generates.
  // Resources first: explicit `as` names (inventory) registered later win, like Laravel.
  const RESOURCE_BASES = [
    'staffs', 'opolo', 'windy', 'four', 'FollowUps', 'BulkProduction', 'Production',
    'Purchase', 'Settings', 'order', 'item', 'itemimage', 'product', 'opolocost', 'Wayfair', 'Tongtool',
  ];
  for (const base of RESOURCE_BASES) {
    const p = singular(base);
    const names: Record<string, string> = {
      index: `/${base}`,
      create: `/${base}/create`,
      store: `/${base}`,
      show: `/${base}/{${p}}`,
      edit: `/${base}/{${p}}/edit`,
      update: `/${base}/{${p}}`,
      destroy: `/${base}/{${p}}`,
    };
    for (const [action, path] of Object.entries(names)) routeTable[`${base}.${action}`] = path;
  }
  for (const r of inv.routes ?? []) {
    if (r.name && r.path) routeTable[r.name] = r.path.startsWith('/') ? r.path : `/${r.path}`;
  }
}

function escapeUri(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

// Laravel `route()`: fill `{param}` segments from params; remaining params
// become a `?a=b&c=d` query string. Returns a relative path, like Laravel's
// route() (views emit these directly). Unknown name -> '' (views only
// reference real routes).
export function routeUrl(name: string, params?: Record<string, unknown> | unknown[]): string {
  const path = routeTable[name];
  if (path === undefined) return '';
  const rest: Record<string, unknown> = Array.isArray(params)
    ? Object.fromEntries(params.map((v, i) => [`arg${i}`, v]))
    : { ...(params ?? {}) };
  // Accepts both Laravel `{x}` and fastify `:x` placeholders (T02 registered `:` style).
  let url = path.replace(/(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:\?)?\}|:([A-Za-z_][A-Za-z0-9_]*))/g, (_m, a: string, b: string) => {
    const key = a || b;
    const v = rest[key];
    delete rest[key];
    if (v === undefined || v === null) return '';
    return escapeUri(String(v));
  });
  const query = Object.entries(rest)
    .map(([k, v]) => `${escapeUri(k)}=${escapeUri(String(v))}`)
    .join('&');
  return query ? `${url}?${query}` : url;
}

// ---------------------------------------------------------------- path helpers

// Laravel `{id}` -> fastify `:id`; `{id?}` -> register both /path and /path/:id.
function toFastifyPath(laravelPath: string): string[] {
  const p = laravelPath.startsWith('/') ? laravelPath : `/${laravelPath}`;
  const m = p.match(/\{([A-Za-z_][A-Za-z0-9_]*)(\?)?\}/);
  if (!m) return [p.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1')];
  const optional = m[2] === '?';
  const converted = p.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(\??)\}/g, (_s, key: string) => `:${key}`);
  const without = p.replace(m[0], '');
  return optional ? [converted, without] : [converted];
}

function verbs(v: RouteVerb): RouteVerb[] {
  return v === 'any' ? ['get', 'post', 'put', 'patch', 'delete', 'options'] : [v];
}

// ---------------------------------------------------------------- middleware

function buildGuard(middleware: string[] | undefined, roles: string[] | undefined): Guard | undefined {
  const list = middleware ?? (roles ? [`role:${roles.join(',')}`] : []);
  if (list.length === 0) return undefined;
  const handlers: Guard[] = list.map((m) => {
    if (m === 'web') return requireLogin;
    if (m === 'auth:api') return passportApiAuth;
    if (m === 'pda.auth') return pdaAuth;
    if (m.startsWith('role:')) return requireRoles(m.slice(5).split(','));
    throw new Error(`router: unhandled middleware '${m}' (T03 — add it here with a parity note)`);
  });
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    for (const h of handlers) {
      await h(req, reply);
      if (reply.sent) return;
    }
  };
}

// ---------------------------------------------------------------- _method spoofing

// Registered handler index for the spoof shims: `${VERB} ${path}` -> handler.
const handlerIndex = new Map<string, { guard: Guard | undefined; handler: RouteHandler }>();

function methodShim(fastifyPath: string): RouteHandler {
  return async (req, reply) => {
    const m = String(input(req, '_method') ?? '').toUpperCase();
    const entry = m && m !== 'POST' ? handlerIndex.get(`${m} ${fastifyPath}`) : undefined;
    if (!entry) {
      // Laravel: POST to a route only defined for PUT/DELETE -> 405.
      reply.code(405).type('text/html; charset=UTF-8').send('405 | Method Not Allowed');
      return;
    }
    if (entry.guard) {
      await entry.guard(req, reply);
      if (reply.sent) return;
    }
    const out = entry.handler(req, reply);
    if (out instanceof Promise) await out;
  };
}

// ---------------------------------------------------------------- route() / any() / resource()

export interface RouteOpts {
  verb: RouteVerb;
  path: string;
  name?: string;
  roles?: string[];
  middleware?: string[];
  handler: RouteHandler;
}

function fastifyRoute(
  app: FastifyInstance,
  verb: RouteVerb,
  fastifyPath: string,
  guard: Guard | undefined,
  handler: RouteHandler,
): void {
  const opts: { preHandler?: Guard } = guard ? { preHandler: guard } : {};
  switch (verb) {
    case 'get': app.get(fastifyPath, opts, handler); break;
    case 'post': app.post(fastifyPath, opts, handler); break;
    case 'put': app.put(fastifyPath, opts, handler); break;
    case 'patch': app.patch(fastifyPath, opts, handler); break;
    case 'delete': app.delete(fastifyPath, opts, handler); break;
    case 'options': app.options(fastifyPath, opts, handler); break;
  }
  handlerIndex.set(`${verb.toUpperCase()} ${fastifyPath}`, { guard, handler });
}

export function route(app: FastifyInstance, opts: RouteOpts): void {
  const guard = buildGuard(opts.middleware, opts.roles);
  for (const v of verbs(opts.verb)) {
    for (const p of toFastifyPath(opts.path)) fastifyRoute(app, v, p, guard, opts.handler);
  }
  // `_method` form spoofing: Laravel HTML forms can only POST; PUT/PATCH/DELETE
  // routes are reached via POST + hidden _method field.
  if (opts.verb !== 'get' && opts.verb !== 'any') {
    for (const p of toFastifyPath(opts.path)) {
      // One shim per path: resource `update` registers both PUT and PATCH.
      if (handlerIndex.has(`POST ${p}`)) continue;
      fastifyRoute(app, 'post', p, guard, methodShim(p));
    }
  }
  if (opts.name) registerRoute(opts.name, opts.path.startsWith('/') ? opts.path : `/${opts.path}`);
}

export function any(app: FastifyInstance, opts: Omit<RouteOpts, 'verb'>): void {
  route(app, { ...opts, verb: 'any' });
}

// Str::singular for the last resource segment (covers the app's resource names;
// shortcut: simple suffix rules, extend if a resource needs irregular forms).
export function singular(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('sses')) return name.slice(0, -2);
  if (name.endsWith('ss')) return name;
  if (name.endsWith('oes')) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

export type ResourceAction = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy';

export interface ResourceHandlers {
  index?: RouteHandler;
  create?: RouteHandler;
  store?: RouteHandler;
  show?: RouteHandler;
  edit?: RouteHandler;
  update?: RouteHandler;
  destroy?: RouteHandler;
}

export interface ResourceOpts {
  roles?: string[];
  middleware?: string[];
  names?: Partial<Record<ResourceAction, string>>;
}

// Route::resource('x', ...): index GET /x, create GET /x/create, store POST /x,
// show GET /x/{x}, edit GET /x/{x}/edit, update PUT|PATCH /x/{x} (+POST spoof),
// destroy DELETE /x/{x} (+POST spoof). Parameter is the singular of the last
// segment; names default to `<base>.<action>` (slashes -> dots, like Laravel).
export function resource(app: FastifyInstance, base: string, handlers: ResourceHandlers, opts: ResourceOpts = {}): void {
  const nameBase = (base.startsWith('/') ? base.slice(1) : base).replace(/\//g, '.');
  const p = singular(base.split('/').pop() ?? base);
  const defs: { action: ResourceAction; verb: RouteVerb; path: string }[] = [
    { action: 'index', verb: 'get', path: base },
    { action: 'create', verb: 'get', path: `${base}/create` },
    { action: 'store', verb: 'post', path: base },
    { action: 'show', verb: 'get', path: `${base}/{${p}}` },
    { action: 'edit', verb: 'get', path: `${base}/{${p}}/edit` },
    { action: 'update', verb: 'put', path: `${base}/{${p}}` },
    { action: 'update', verb: 'patch', path: `${base}/{${p}}` },
    { action: 'destroy', verb: 'delete', path: `${base}/{${p}}` },
  ];
  for (const d of defs) {
    const handler = handlers[d.action];
    if (!handler) continue;
    route(app, {
      verb: d.verb,
      path: d.path,
      name: opts.names?.[d.action] ?? `${nameBase}.${d.action}`,
      roles: opts.roles,
      middleware: opts.middleware,
      handler,
    });
  }
}

// ---------------------------------------------------------------- not-found fallback

// Laravel's regex catch-alls (routes/web.php), in original registration order.
// The parameter value (single path segment, may be empty) must match the class.
interface FallbackDef { name: string; re: RegExp; roles: string[] }

const CATCHALLS: FallbackDef[] = [
  { name: 'Supplier', re: /^\/([\ /Supplier\.-]*)$/, roles: ['admin', 'user', 'supplier'] },
  { name: 'ListProducts', re: /^\/([\ /ListProducts\.-]*)$/, roles: ['admin', 'user', 'remote'] },
  { name: 'InventoryCount', re: /^\/([\ /InventoryCount\.-]*)$/, roles: ['admin', 'user', 'remote'] },
  { name: 'InventoryConsolidation', re: /^\/([\ /InventoryConsolidation\.-]*)$/, roles: ['admin', 'user', 'remote'] },
  { name: 'Orders', re: /^\/([\ /Orders\.-]*)$/, roles: ['admin', 'user', 'remote'] },
];

const fallbacks = new Map<string, RouteHandler>();

// T26/T30 register their Product@vue / SupplierProduct@index handlers here.
export function registerFallback(name: string, handler: RouteHandler): void {
  fallbacks.set(name, handler);
}

// The old app has no resources/views/errors/404 view, so Laravel falls through
// to Symfony's default 404 HTML page (HttpException::createResponse).
const SYMFONY_404 = `<!DOCTYPE html>
<html>
    <head>
        <meta charset="UTF-8" />
        <meta name="robots" content="noindex,nofollow" />
        <title>404 | Not Found</title>
        <style>
            body { background-color: #fff; color: #222; font-family: sans-serif; font-size: 16px; font-weight: 400; }

            a { color: #777; text-decoration: underline; }
            a:hover { color: #bd5b00; text-decoration: underline; }

            a img { border: none; }

            p { margin: 1em 0; }
            h1, h2, h3, h4, h5, h6 { font-weight: bold; }
            h1, h2, h3, h4 { margin: 0; }
            img { display: block; margin: 0 auto; }

            h1 { font-size: 32px; color: #bd3625; margin-bottom: 0.6667em; padding: 0; }

            h2 { font-size: 24px; }

            h3 { font-size: 18px; }

            h4 { font-size: 14px; }

            h5 { font-size: 12px; }

            h6 { font-size: 10px; }

            ul, ol { margin-left: 10px; }

            pre { padding: 8px; background-color: #fff; border: 1px solid #ccc; clear: both; white-space: pre-wrap; }

            form { display: none; }
        </style>
    </head>
    <body>
        <h1>404 | Not Found</h1>
        <p>Whoops, looks like something went wrong.</p>
    </body>
</html>
`;

async function sendNotFound(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.code(404).type('text/html; charset=UTF-8').send(SYMFONY_404);
}

// Must be called before any root-level route registration.
export function installRouter(app: FastifyInstance): void {
  app.setNotFoundHandler(async (req, reply): Promise<void> => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      pathname = req.url;
    }
    for (const def of CATCHALLS) {
      if (!def.re.test(pathname)) continue;
      const handler = fallbacks.get(def.name);
      if (!handler) return sendNotFound(req, reply); // T26/T30 not ported yet
      const auth = await currentUser(req);
      if (!auth.user) {
        (req.session as Record<string, unknown>)['intended'] = `${req.protocol}://${req.host}${req.raw.url ?? '/'}`;
        (req as { saveSession?: () => Promise<void> }).saveSession?.();
        return lredirect(req, reply, '/login');
      }
      if (!hasRole(auth, def.roles)) {
        return reply.type('text/html; charset=UTF-8').code(403).send('No Access.');
      }
      const out = handler(req, reply);
      if (out instanceof Promise) await out;
      return;
    }
    return sendNotFound(req, reply);
  });
}
