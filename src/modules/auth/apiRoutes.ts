// guest:api group from routes/api.php: POST /api/login only (registration and password reset were removed on
// purpose; admins manage users). Same Laravel 5.4 auth-trait controller as the web route, but the api middleware group has no session:
// failures answer 422/423 JSON when the client expects JSON, else 302 back.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import { input, redirectBack } from '../../http.js';
import {
  loginThrottleAvailableIn,
  loginThrottleHit,
  loginThrottleTooMany,
  requireApiGuest,
  throttleKey,
  verifyPassword,
} from '../../auth.js';
import { trans } from '../../view.js';
import { loginValidation, type Errors } from './shared.js';

// Request::expectsJson(): ajax (non-pjax) or an Accept header whose first type is json.
function expectsJson(req: FastifyRequest): boolean {
  const ajax = req.headers['x-requested-with'] === 'XMLHttpRequest' && !req.headers['x-pjax'];
  const accept = String(req.headers['accept'] ?? '').split(',')[0];
  return ajax || accept.includes('/json') || accept.includes('+json');
}

// ValidatesRequests::buildFailedValidationResponse: JSON 422 or redirect back.
function failValidation(req: FastifyRequest, reply: FastifyReply, errors: Errors): void {
  if (expectsJson(req)) reply.code(422).send(errors);
  else redirectBack(req, reply);
}

// Laravel's unhandled-exception page (APP_DEBUG trace is not reproducible), as in the web routes.
function serverError(reply: FastifyReply): void {
  reply.code(500).type('text/html; charset=UTF-8').send('500 | Server Error');
}

async function handleLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const email = input(req, 'email');
  const password = input(req, 'password');
  const validationErrors = loginValidation(email, password);
  if (Object.keys(validationErrors).length > 0) return failValidation(req, reply, validationErrors);

  const key = throttleKey(String(email), req.ip);
  if (loginThrottleTooMany(key)) {
    const errors = { email: trans('auth.throttle', { seconds: loginThrottleAvailableIn(key) }) };
    if (expectsJson(req)) reply.code(423).send(errors);
    else redirectBack(req, reply);
    return;
  }

  const user = await db
    .selectFrom('os_users')
    .select(['id', 'password', 'remember_token'])
    .where('email', '=', String(email))
    .executeTakeFirst();
  if (user && verifyPassword(String(password), user.password)) {
    // guard->attempt($credentials, $request->has('remember')) stores a remember token when missing...
    if (input(req, 'remember') && !user.remember_token) {
      await db.updateTable('os_users').set({ remember_token: randomBytes(30).toString('hex') }).where('id', '=', user.id).execute();
    }
    // ...then sendLoginResponse calls $request->session()->regenerate(), and the api group
    // has no session on the request -> RuntimeException "Session store not set on request."
    return serverError(reply);
  }

  loginThrottleHit(key);
  const errors = { email: trans('auth.failed') };
  if (expectsJson(req)) reply.code(422).send(errors);
  else redirectBack(req, reply);
}

export function registerApiGuestRoutes(app: FastifyInstance): void {
  const guest = { preHandler: [requireApiGuest] };
  app.post('/api/login', guest, handleLogin);
}
