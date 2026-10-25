// Web auth routes: Route::auth() (Laravel 5.4) + HomeController@index for / and /home.
// Views: auth/login, auth/register, auth/passwords/email, auth/passwords/reset, home.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import { allInput, input, lredirect, redirectBack, sanitizeOldInput } from '../../http.js';
import { registerRoute } from '../../router.js';
import {
  currentUser,
  hasRole,
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
import { emailValidation, loginValidation, registerValidation, resetPassword, resetValidation, sendResetLink, type Errors } from './shared.js';

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
    lredirect(req, reply, intended ?? '/home');
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

async function handlePasswordEmail(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const email = input(req, 'email');
  const errors = emailValidation(email);
  if (Object.keys(errors).length > 0) {
    reply.withErrors(errors).withInput(sanitizeOldInput(allInput(req)));
    redirectBack(req, reply);
    return;
  }
  const key = await sendResetLink(String(email));
  if (key === 'passwords.sent') reply.flashStatus(trans(key));
  else reply.withErrors({ email: trans(key) });
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
  const result = await resetPassword(data);
  if (result.userId === undefined) {
    reply.withErrors({ email: trans(result.key) }).withInput({ email: data['email'] });
    redirectBack(req, reply);
    return;
  }
  const session = req.session as Record<string, unknown>;
  session['user_id'] = result.userId;
  (req as { saveSession?: () => Promise<void> }).saveSession?.();
  reply.flashStatus(trans(result.key));
  lredirect(req, reply, '/home');
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
      lredirect(req, reply, '/login');
      return;
    }
    // parity: supplier redirect has no withInput()
    if (hasRole(auth, ['user', 'admin', 'remote'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      lredirect(req, reply, '/summary');
    } else if (hasRole(auth, ['opolo'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      lredirect(req, reply, '/opolo');
    } else if (hasRole(auth, ['windy'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      lredirect(req, reply, '/windy');
    } else if (hasRole(auth, ['four'])) {
      (req.session as Record<string, unknown>)['old'] = allInput(req);
      lredirect(req, reply, '/four');
    } else if (hasRole(auth, ['supplier'])) {
      lredirect(req, reply, '/Supplier');
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
    lredirect(req, reply, '/');
  });
  registerRoute('logout', '/logout');

  app.get('/register', { preHandler: [requireGuest] }, async (req, reply) => {
    await render(req, reply, 'auth/register');
  });
  registerRoute('register', '/register');

  app.post('/register', { preHandler: [requireGuest] }, async (req, reply) => {
    const data = allInput(req);
    const errors = await registerValidation(data);
    if (Object.keys(errors).length > 0) {
      reply.withErrors(errors).withInput(sanitizeOldInput(data));
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
