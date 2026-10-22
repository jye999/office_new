// Laravel-compatible request/response helpers shared by route modules.
// `input()` mirrors Laravel's `input()`: JSON/form body first, then query.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

// Laravel's ValidationException handler drops passwords from flashed old input.
export function sanitizeOldInput(input: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, password_confirmation: _password_confirmation, ...rest } = input;
  return rest;
}

// redirect()->back(): Referer header, or the app root.
export function redirectBack(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const referer = req.headers['referer'];
  return reply.redirect(typeof referer === 'string' && referer ? referer : '/');
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