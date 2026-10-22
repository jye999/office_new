// Web auth routes: Route::auth() (Laravel 5.4) + HomeController@index for / and /home.
// Views: auth/login, auth/register, auth/passwords/email, auth/passwords/reset, home.

import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { db, nowDb } from '../../db.js';
import { allInput, input, redirectBack, sanitizeOldInput } from '../../http.js';
import { registerRoute } from '../../router.js';
import {
  currentUser,
  hasRole,
  hashPassword,
  loginThrottleAvailableIn,
  loginThrottleClear,
  loginThrottleHit,
  loginThrottleTooMany,
  requireGuest,
  requireLogin,
  throttleKey,
  verifyPassword,
} from '../../auth.js';
import { render, trans } from '../../view.js';

// ---------------------------------------------------------------- validation

type Errors = Record<string, string[]>;

function attr(name: string): string {
  return name.replace(/_/g, ' ');
}

// filter_var(..., FILTER_VALIDATE_EMAIL) parity for the `email` rule.
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function required(v: unknown): boolean {
  return v !== null && v !== undefined && (typeof v !== 'string' || v.length > 0);
}

function loginValidation(email: unknown, password: unknown): Errors {
  const errors: Errors = {};
  if (!required(email)) errors['email'] = [trans('validation.required', { attribute: attr('email') })];
  else if (typeof email !== 'string') errors['email'] = [trans('validation.string', { attribute: attr('email') })];
  if (!required(password)) errors['password'] = [trans('validation.required', { attribute: attr('password') })];
  else if (typeof password !== 'string') errors['password'] = [trans('validation.string', { attribute: attr('password') })];
  return errors;
}

function registerValidation(data: Record<string, unknown>): Errors {
  const errors: Errors = {};
  if (!required(data['name'])) errors['name'] = [trans('validation.required', { attribute: attr('name') })];
  else if (typeof data['name'] !== 'string' || data['name'].length > 255) errors['name'] = [trans('validation.max', { attribute: attr('name'), max: 255 })];
  if (!required(data['email'])) errors['email'] = [trans('validation.required', { attribute: attr('email') })];
  else if (typeof data['email'] !== 'string' || !EMAIL_RE.test(data['email'])) errors['email'] = [trans('validation.email', { attribute: attr('email') })];
  else if (data['email'].length > 255) errors['email'] = [trans('validation.max', { attribute: attr('email'), max: 255 })];
  if (!required(data['password'])) errors['password'] = [trans('validation.required', { attribute: attr('password') })];
  else if (typeof data['password'] !== 'string' || data['password'].length < 6) errors['password'] = [trans('validation.min', { attribute: attr('password'), min: 6 })];
  else if (data['password'] !== data['password_confirmation']) errors['password'] = [trans('validation.confirmed', { attribute: attr('password') })];
  return errors;
}

function resetValidation(data: Record<string, unknown>): Errors {
  const errors: Errors = {};
  if (!required(data['token'])) errors['token'] = [trans('validation.required', { attribute: attr('token') })];
  if (!required(data['email'])) errors['email'] = [trans('validation.required', { attribute: attr('email') })];
  else if (typeof data['email'] !== 'string' || !EMAIL_RE.test(data['email'])) errors['email'] = [trans('validation.email', { attribute: attr('email') })];
  if (!required(data['password'])) errors['password'] = [trans('validation.required', { attribute: attr('password') })];
  else if (typeof data['password'] !== 'string' || data['password'].length < 6) errors['password'] = [trans('validation.min', { attribute: attr('password'), min: 6 })];
  else if (data['password'] !== data['password_confirmation']) errors['password'] = [trans('validation.confirmed', { attribute: attr('password') })];
  return errors;
}

function wantsJson(req: FastifyRequest): boolean {
  return req.headers['x-requested-with'] === 'XMLHttpRequest';
}

// ---------------------------------------------------------------- login

async function handleLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const email = input(req, 'email');
  const password = input(req, 'password');

  const validationErrors = loginValidation(email, password);
  if (Object.keys(validationErrors).length > 0) {
    reply.withErrors(validationErrors).withInput(sanitizeOldInput(allInput(req)));
    redirectBack(req, reply);
    return;
  }

  const key = throttleKey(String(email), req.ip);
  if (loginThrottleTooMany(key)) {
    const seconds = loginThrottleAvailableIn(key);
    const errors: Errors = { email: [trans('auth.throttle', { seconds })] };
    if (wantsJson(req)) {
      // parity: ThrottlesLogins::sendLockoutResponse returns 423 (not 429)
      reply.code(423).send(errors);
      return;
    }
    reply.withErrors(errors).withInput({ email, ...(input(req, 'remember') ? { remember: input(req, 'remember') } : {}) });
    redirectBack(req, reply);
    return;
  }

  const user = await db
    .selectFrom('os_users')
    .select(['id', 'password'])
    .where('email', '=', String(email))
    .executeTakeFirst();
  if (user && verifyPassword(String(password), user.password)) {
    loginThrottleClear(key);
    const session = req.session as Record<string, unknown>;
    const intended = sessionIntendedOf(req); // read before clearing (Laravel order)
    session['user_id'] = user.id;
    delete session['intended'];
    (req as { saveSession?: () => Promise<void> }).saveSession?.();
    reply.redirect(intended ?? '/home');
    return;
  }

  loginThrottleHit(key);
  reply
    .withErrors({ email: trans('auth.failed') })
    .withInput({ email, ...(input(req, 'remember') ? { remember: input(req, 'remember') } : {}) });
  redirectBack(req, reply);
}

function sessionIntendedOf(req: FastifyRequest): string | null {
  const v = (req.session as Record<string, unknown> | undefined)?.['intended'];
  return typeof v === 'string' && v ? v : null;
}

// ---------------------------------------------------------------- password reset

// config('passwords.users'): table password_resets (os_ prefixed), expire 60 min.
const RESET_EXPIRE_MINUTES = 60;

function resetToken(): string {
  // DatabaseTokenRepository::createNewToken(): hash_hmac('sha256', random 40, app key)
  return createHmac('sha256', config.APP_KEY).update(randomBytes(20).toString('binary')).digest('hex');
}

async function handlePasswordEmail(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const email = input(req, 'email');
  if (!required(email)) {
    reply.withErrors({ email: trans('validation.required', { attribute: attr('email') }) }).withInput(sanitizeOldInput(allInput(req)));
    redirectBack(req, reply);
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    reply.withErrors({ email: trans('validation.email', { attribute: attr('email') }) }).withInput(sanitizeOldInput(allInput(req)));
    redirectBack(req, reply);
    return;
  }
  const user = await db
    .selectFrom('os_users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (!user) {
    reply.withErrors({ email: trans('passwords.user') });
    redirectBack(req, reply);
    return;
  }
  const token = resetToken();
  await db
    .insertInto('os_password_resets')
    // SAFETY: Kysely types this timestamp column as Date, but mysql2 sends the
    // 'YYYY-MM-DD HH:mm:ss' string through unchanged (same value Laravel writes).
    .values({ email, token, created_at: nowDb() as unknown as Date })
    .execute();
  if (process.env.MAIL_ENABLED === '1') {
    // MAIL_ENABLED gates the send (default off). T04's mail.ts sends it; log for now.
    console.log(`[mail] password reset link for ${email}: ${config.APP_URL}/password/reset/${token}?email=${encodeURIComponent(email)}`);
  }
  reply.flashStatus(trans('passwords.sent'));
  redirectBack(req, reply);
}

async function handlePasswordReset(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const data = allInput(req);
  const validationErrors = resetValidation(data);
  if (Object.keys(validationErrors).length > 0) {
    reply.withErrors(validationErrors).withInput(sanitizeOldInput(data));
    redirectBack(req, reply);
    return;
  }

  const token = String(data['token']);
  const email = String(data['email']);
  const cutoff = new Date(Date.now() - RESET_EXPIRE_MINUTES * 60_000);
  const row = await db
    .selectFrom('os_password_resets')
    .select('created_at')
    .where('email', '=', email)
    .where('token', '=', token)
    .executeTakeFirst();
  const user = await db
    .selectFrom('os_users')
    .select(['id', 'password', 'remember_token'])
    .where('email', '=', email)
    .executeTakeFirst();

  // broker: exists() requires a live token row AND a user; any miss -> "invalid token"
  const expiresAt = row ? new Date(String(row.created_at).replace(' ', 'T')) : null;
  if (!row || !user || !expiresAt || expiresAt <= cutoff) {
    reply.withErrors({ email: trans('passwords.token') }).withInput({ email });
    redirectBack(req, reply);
    return;
  }

  const newHash = hashPassword(String(data['password']));
  await db
    .updateTable('os_users')
    .set({ password: newHash, remember_token: randomBytes(30).toString('hex') })
    .where('id', '=', user.id)
    .execute();
  await db.deleteFrom('os_password_resets').where('email', '=', email).where('token', '=', token).execute();
  const session = req.session as Record<string, unknown>;
  session['user_id'] = user.id;
  (req as { saveSession?: () => Promise<void> }).saveSession?.();
  reply.flashStatus(trans('passwords.reset'));
  reply.redirect('/home');
}

// ---------------------------------------------------------------- routes

export function registerAuthRoutes(app: FastifyInstance): void {
  // GET / and /home (both named 'home'): HomeController@index role redirects.
  const homeHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = await currentUser(req);
    if (!auth.user) {
      const session = req.session as Record<string, unknown>;
      session['intended'] = `${req.protocol}://${req.host}${req.raw.url ?? '/'}`;
      (req as { saveSession?: () => Promise<void> }).saveSession?.();
      reply.redirect('/login');
      return;
    }
    // parity: supplier redirect has no withInput()
    if (hasRole(auth, ['user', 'admin', 'remote'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      reply.redirect('/summary');
    } else if (hasRole(auth, ['opolo'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      reply.redirect('/opolo');
    } else if (hasRole(auth, ['windy'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      reply.redirect('/windy');
    } else if (hasRole(auth, ['four'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      reply.redirect('/four');
    } else if (hasRole(auth, ['supplier'])) {
      reply.redirect('/Supplier');
    } else {
      await render(req, reply, 'home');
    }
  };
  app.get('/', { preHandler: [requireLogin] }, homeHandler);
  app.get('/home', { preHandler: [requireLogin] }, homeHandler);
  registerRoute('home', '/home');

  app.get('/login', { preHandler: [requireGuest] }, async (req, reply) => {
    await render(req, reply, 'auth/login');
  });
  registerRoute('login', '/login');

  app.post('/login', { preHandler: [requireGuest] }, handleLogin);

  // logout is the one auth route not behind `guest`.
  app.post('/logout', async (req, reply) => {
    const session = req.session as Record<string, unknown>;
    delete session['user_id'];
    delete session['intended'];
    (req as { saveSession?: () => Promise<void> }).saveSession?.();
    reply.redirect('/');
  });
  registerRoute('logout', '/logout');

  app.get('/register', { preHandler: [requireGuest] }, async (req, reply) => {
    await render(req, reply, 'auth/register');
  });
  registerRoute('register', '/register');

  app.post('/register', { preHandler: [requireGuest] }, async (req, reply) => {
    const data = allInput(req);
    const errors = registerValidation(data);
    if (Object.keys(errors).length > 0) {
      reply.withErrors(errors).withInput(sanitizeOldInput(data));
      redirectBack(req, reply);
      return;
    }
    const existing = await db
      .selectFrom('os_users')
      .select('id')
      .where('email', '=', String(data['email']))
      .executeTakeFirst();
    if (existing) {
      reply.withErrors({ email: trans('validation.unique', { attribute: attr('email') }) }).withInput(sanitizeOldInput(data));
      redirectBack(req, reply);
      return;
    }
    // parity quirk: RegisterController::create() is commented out in the old app,
    // so $user is null and the framework's typed guard->login(null) throws a
    // TypeError -> 500. Plan: NOTES.md T02.
    reply.code(500).type('text/html; charset=UTF-8').send('500 | Server Error');
  });

  app.get('/password/reset', { preHandler: [requireGuest] }, async (req, reply) => {
    await render(req, reply, 'auth/passwords/email');
  });
  registerRoute('password.request', '/password/reset');

  app.post('/password/email', { preHandler: [requireGuest] }, handlePasswordEmail);
  registerRoute('password.email', '/password/email');

  app.get<{ Params: { token: string } }>('/password/reset/:token', { preHandler: [requireGuest] }, async (req, reply) => {
    await render(req, reply, 'auth/passwords/reset', {
      token: req.params.token,
      email: input(req, 'email') ?? '',
    });
  });
  registerRoute('password.reset', '/password/reset/:token');

  app.post('/password/reset', { preHandler: [requireGuest] }, handlePasswordReset);
}
