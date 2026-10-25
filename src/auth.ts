// Web session auth (T02): user lookup, role guard, PDA api-key guard,
// Passport (auth:api) Bearer-JWT guard.

import { createHash, createVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { db } from './db.js';
import { input, lredirect } from './http.js';
import type { TemplateValue } from './view.js';

export interface AuthUser {
  id: number;
  name: string | null;
  email: string;
  username: string;
  company_id: number;
}

export interface Auth {
  user: AuthUser | null;
  roles: string[];
}

// Per-request cache key (Symbol) so repeated currentUser() calls in one
// request hit the DB once.
const authCacheKey = Symbol('currentUser');
type AuthCache = FastifyRequest & { [authCacheKey]?: Promise<Auth> };

// Session contract with the view layer: the web session stores the logged-in
// user's id as `user_id` (mirrors the old app's session-auth lookup).
export async function currentUser(req: FastifyRequest): Promise<Auth> {
  const cached = (req as AuthCache)[authCacheKey];
  if (cached) return cached;
  const promise = (async () => {
    const id = (req.session as Record<string, unknown> | undefined)?.user_id;
    if (typeof id !== 'number' || !id) return { user: null, roles: [] };
    const user = await db
      .selectFrom('os_users')
      .select(['id', 'name', 'email', 'username', 'company_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) return { user: null, roles: [] };
    const roleRows = await db
      .selectFrom('os_user_has_roles')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select('os_roles.name')
      .where('os_user_has_roles.user_id', '=', id)
      .execute();
    return { user, roles: roleRows.map((r) => r.name) };
  })();
  (req as AuthCache)[authCacheKey] = promise;
  return promise;
}

// spatie/laravel-permission @role([...]): true when the user has any of the roles.
export function hasRole(auth: Auth, roles: string | string[]): boolean {
  if (!auth.user) return false;
  const list = Array.isArray(roles) ? roles : [roles];
  return list.some((r) => auth.roles.includes(r));
}

function intendedUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}${req.raw.url ?? '/'}`;
}

// session('url.intended')
function sessionIntended(req: FastifyRequest): string | null {
  const v = (req.session as Record<string, unknown> | undefined)?.['intended'];
  return typeof v === 'string' && v ? v : null;
}

// `auth` middleware (no roles): 302 to /login remembering the intended URL.
export async function requireLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = await currentUser(req);
  if (auth.user) return;
  const session = req.session as Record<string, unknown>;
  session['intended'] = intendedUrl(req);
  (req as AuthCache & { saveSession?: () => Promise<void> }).saveSession?.();
  lredirect(req, reply, '/login');
}

// RoleMiddleware (`role:a,b`): no user -> /login; user without any role -> 403 "No Access.".
export function requireRoles(roles: string | string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = await currentUser(req);
    if (!auth.user) {
      const session = req.session as Record<string, unknown>;
      session['intended'] = intendedUrl(req);
      (req as AuthCache & { saveSession?: () => Promise<void> }).saveSession?.();
      lredirect(req, reply, '/login');
      return;
    }
    if (!hasRole(auth, roles)) {
      reply.type('text/html; charset=UTF-8').code(403).send('No Access.');
    }
  };
}

// `guest` middleware: authenticated -> /home (config('auth.redirect') unset).
export async function requireGuest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = await currentUser(req);
  if (auth.user) lredirect(req, reply, '/home');
}

// ---------------------------------------------------------------- bcrypt

// Laravel stores $2y$ bcrypt; bcryptjs compares $2a$ natively and also accepts
// $2y$, but normalise like the task contract does (drop $2b$ variants too).
export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash.replace(/^\$2[byx]\$/, '$2a$'));
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

// ---------------------------------------------------------------- login throttle

// In-memory port of Laravel's RateLimiter for ThrottlesLogins (5 tries/min):
// counter per key with a 60 s decay, plus a separate one-shot lockout.
interface ThrottleState {
  attempts: number;
  attemptsUntil: number;
  lockoutUntil: number;
}

const loginAttempts = new Map<string, ThrottleState>();
const THROTTLE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

export function throttleKey(email: string, ip: string): string {
  return `${email.toLowerCase()}|${ip}`;
}

export function loginThrottleTooMany(key: string, now: number = Date.now()): boolean {
  const s = loginAttempts.get(key);
  if (s && s.lockoutUntil > now) return true;
  if (s && s.attemptsUntil > now && s.attempts >= MAX_ATTEMPTS) {
    s.lockoutUntil = now + THROTTLE_WINDOW_MS;
    s.attempts = 0;
    s.attemptsUntil = 0; // resetAttempts()
    return true;
  }
  return false;
}

export function loginThrottleHit(key: string, now: number = Date.now()): void {
  const s = loginAttempts.get(key);
  if (!s || s.attemptsUntil <= now) loginAttempts.set(key, { attempts: 1, attemptsUntil: now + THROTTLE_WINDOW_MS, lockoutUntil: s?.lockoutUntil ?? 0 });
  else s.attempts += 1;
}

export function loginThrottleAvailableIn(key: string, now: number = Date.now()): number {
  const s = loginAttempts.get(key);
  return s && s.lockoutUntil > now ? Math.max(0, Math.ceil((s.lockoutUntil - now) / 1000)) : 0;
}

export function loginThrottleClear(key: string, _now: number = Date.now()): void {
  const s = loginAttempts.get(key);
  if (s) s.attempts = 0; // clear() forgets the counter, not the lockout
}

// ---------------------------------------------------------------- PDA api key

// Port of app/Http/Middleware/AuthenticateApiKey.php.
export async function pdaAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let plain: string | null = null;
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    plain = authHeader.slice(7).trim();
  }
  if (plain === null || plain === '') {
    const xApiKey = req.headers['x-api-key'];
    plain = typeof xApiKey === 'string' ? xApiKey : null;
  }
  if (plain === null || plain === '') plain = input(req, 'api_key');
  if (plain === null || plain === '') {
    reply.code(401).send({ message: 'API key required' });
    return;
  }
  const hash = createHash('sha256').update(plain).digest('hex');
  const row = await db
    .selectFrom('os_user_api_tokens')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirst();
  if (!row) {
    reply.code(401).send({ message: 'Invalid API key' });
    return;
  }
  const user = await db
    .selectFrom('os_users')
    .selectAll()
    .where('id', '=', row.user_id)
    .executeTakeFirst();
  if (!user) {
    reply.code(401).send({ message: 'Invalid API key' });
    return;
  }
  (req as { pdaUser?: (typeof user) })['pdaUser'] = user;
}

// ---------------------------------------------------------------- Passport (auth:api)

// The api guard driver is `passport` (config/auth.php). The compiled Vue bundle
// authenticates with session cookies, so these routes only matter for external
// Bearer clients: JWT signed with the app's oauth RSA keys, `id` claim looked
// up in os_oauth_access_tokens (passport personal access tokens).
export interface ApiUser {
  id: number;
  username: string;
  email: string;
  confirmation_code: string;
  confirmed: number;
  created_at: string;
  updated_at: string | null;
  company_id: number;
  name: string | null;
}

// Kysely types `timestamp` columns as Date, but mysql2 dateStrings (T00) yields
// 'YYYY-MM-DD HH:mm:ss' strings at runtime. SAFETY: String() is a no-op on those.
function dbDate(v: Date | string | null): string | null {
  return v === null ? null : String(v);
}

// User model $hidden = [password, remember_token]: /api/user serialises the rest.
export function serializeApiUser(row: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, remember_token: _remember_token, ...rest } = row;
  return rest;
}

let cachedPublicJwk: { key: string } | null = null;

function oauthPublicKey(): string | null {
  if (cachedPublicJwk?.key) return cachedPublicJwk.key;
  const p = path.join(config.PUBLIC_DIR, '..', 'storage', 'oauth-public.key');
  try {
    cachedPublicJwk = { key: fs.readFileSync(p, 'utf8') };
    return cachedPublicJwk.key;
  } catch {
    return null;
  }
}

function b64urlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verifies a passport RS256 JWT and loads the unrevoked token's user (null when absent/invalid).
async function passportUser(req: FastifyRequest): Promise<ApiUser | null> {
  const header = req.headers['authorization'];
  const token =
    typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : null;
  if (!token) return null;
  const parts = token.split('.');
  const publicKey = oauthPublicKey();
  if (parts.length !== 3 || !publicKey) return null;
  let payload: { psp?: string; id?: string; sub?: string; alg?: string };
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  const verify = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`);
  if (!verify.verify(publicKey, b64urlDecode(parts[2]))) return null;
  if (payload.psp !== 'passport' || typeof payload.id !== 'string' || typeof payload.sub !== 'string') {
    return null;
  }
  const row = await db
    .selectFrom('os_oauth_access_tokens')
    .selectAll()
    .where('id', '=', payload.id)
    .where('revoked', '=', 0)
    .executeTakeFirst();
  if (!row) return null;
  const user = await db
    .selectFrom('os_users')
    .selectAll()
    .where('id', '=', Number(payload.sub))
    .executeTakeFirst();
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    confirmation_code: user.confirmation_code,
    confirmed: user.confirmed,
    created_at: dbDate(user.created_at) as string,
    updated_at: dbDate(user.updated_at),
    company_id: user.company_id,
    name: user.name,
  };
}

// `auth:api`: 401 {"message":"Unauthenticated"} unless a valid bearer token resolves a user.
export async function passportApiAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await passportUser(req);
  if (!user) {
    reply.code(401).send({ message: 'Unauthenticated' });
    return;
  }
  (req as { apiUser?: ApiUser })['apiUser'] = user;
}

// `guest:api` (RedirectIfAuthenticated): a valid bearer token redirects to /home.
export async function requireApiGuest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (await passportUser(req)) lredirect(req, reply, '/home');
}

export type { TemplateValue };
