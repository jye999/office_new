// Laravel-compatible request/response helpers shared by route modules.
// `input()` mirrors Laravel's `input()`: JSON/form body first, then query.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from './db.js';
import type { TemplateValue } from './view.js';

export function input<T = unknown>(req: FastifyRequest, key: string): T | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  return (key in body ? body[key] : query[key] ?? null) as T | null;
}

// `$request->all()`: body takes precedence over query (same merge as input()).
export function allInput(req: FastifyRequest): Record<string, unknown> {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  return { ...query, ...body };
}

// ---------------------------------------------------------------- paginate

// Structural Kysely select query (avoids fighting the generic typing).
// Kysely queries are immutable: every call returns a new builder, so no clone().
interface Paginatable {
  clearSelect(): Paginatable;
  clearOrderBy(): Paginatable;
  select(selector: unknown): Paginatable;
  offset(n: number): Paginatable;
  limit(n: number): Paginatable;
  execute(): Promise<unknown[]>;
}

// Laravel 5.4 `->paginate(n)` JSON (LengthAwarePaginator::toArray). 5.4 has no
// first_page_url/links keys; `from` is negative when total is 0 (kept quirk).
export async function paginate(query: Paginatable, perPage: number, req: FastifyRequest) {
  const rawPage = Number(input(req, 'page'));
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const [{ total }] = (await query
    .clearSelect()
    .clearOrderBy()
    .select(sql`count(*)`.as('total'))
    .execute()) as { total: number }[];
  const data = (await query.offset((page - 1) * perPage).limit(perPage).execute()) as unknown[];
  const path = `${req.protocol}://${req.host}${new URL(req.url, 'http://localhost').pathname}`;
  const url = (p: number) => `${path}?page=${p}`;
  const lastPage = Math.ceil(total / perPage);
  const lastItem = total ? Math.min(total, page * perPage) : 0;
  return {
    current_page: page,
    data,
    from: lastItem - perPage + 1,
    last_page: lastPage,
    next_page_url: page < lastPage ? url(page + 1) : null,
    path,
    per_page: perPage,
    prev_page_url: page > 1 ? url(page - 1) : null,
    to: lastItem,
    total,
  };
}

// Laravel's ValidationException handler drops passwords from flashed old input.
export function sanitizeOldInput(input: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, password_confirmation: _password_confirmation, ...rest } = input;
  return rest;
}

// redirect()->back(): Referer header, or the app root.
export function redirectBack(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const referer = req.headers['referer'];
  return lredirect(req, reply, typeof referer === 'string' && referer ? referer : '/');
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

// Laravel redirect(): 302 Location: <absolute> plus the framework's HTML body
// (meta refresh + "Redirecting to …" link). reply.redirect() alone sends an
// empty body, which breaks HTML parity.
export function lredirect(req: FastifyRequest, reply: FastifyReply, to: string): FastifyReply {
  const absolute = to.startsWith('http') ? to : `${req.protocol}://${req.host}${to.startsWith('/') ? '' : '/'}${to}`;
  reply
    .code(302)
    .header('Location', absolute)
    .type('text/html; charset=UTF-8')
    .send(
      `<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta http-equiv="refresh" content="0;url='${escapeHtml(absolute)}'"` +
        ` /><title>Redirecting to ${escapeHtml(absolute)}</title></head>` +
        `<body>Redirecting to <a href="${escapeHtml(absolute)}">${escapeHtml(absolute)}</a>.</body></html>`,
    );
  return reply;
}

// @fastify/secure-session decorates req.session at runtime with this API; it is
// guaranteed present on requests handled after registerViewPlugins().
// SAFETY: the cast matches the plugin's documented session object shape.
interface SecureSession {
  get(key: string): TemplateValue;
  set(key: string, value: TemplateValue): void;
}

function setFlash(req: FastifyRequest, key: string, value: TemplateValue): void {
  const session = req.session as SecureSession;
  const flash = (session.get('flash') ?? {}) as Record<string, TemplateValue>;
  const next: Record<string, TemplateValue> = { ...flash };
  next[key] = value;
  session.set('flash', next);
}

// old input lives at the top-level session key `old` (the shape buildContext reads).
function setSession(req: FastifyRequest, key: string, value: TemplateValue): void {
  (req.session as SecureSession).set(key, value);
}

declare module 'fastify' {
  interface FastifyReply {
    // withErrors([...]): flash a Laravel error bag (strings become single-message arrays).
    withErrors(errors: Record<string, string | string[]>): FastifyReply;
    // withInput([...]): flash old input for re-populating form fields.
    withInput(input: Record<string, unknown>): FastifyReply;
    // with('status', ...): flash a success message.
    flashStatus(message: string): FastifyReply;
  }
}

// fastify-plugin so the reply decorators are visible to routes registered
// outside this scope (root-level route modules).
export const registerHttpHelpers = fp(async (app: FastifyInstance): Promise<void> => {
  app.decorateReply('withErrors', function (this: FastifyReply, errors: Record<string, string | string[]>) {
    setFlash(this.request, 'errors', Object.fromEntries(
      Object.entries(errors).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]),
    ));
    return this;
  });

  app.decorateReply('withInput', function (this: FastifyReply, input: Record<string, unknown>) {
    setSession(this.request, 'old', input as Record<string, TemplateValue>);
    return this;
  });

  app.decorateReply('flashStatus', function (this: FastifyReply, message: string) {
    setFlash(this.request, 'status', message);
    return this;
  });

}, { name: 'http-helpers' });