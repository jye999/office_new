// guest:api routes (POST /api/login only; registration and password reset were removed).
// DB tests use AG-prefixed temp rows deleted in afterEach; MAIL_ENABLED stays unset (no mail).

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, loginThrottleClear, throttleKey, verifyPassword } from '../src/auth.js';
import { db, nowDb } from '../src/db.js';
import { registerApiGuestRoutes } from '../src/modules/auth/apiRoutes.js';

const PREFIX = 'agtest';
const EMAIL = `${PREFIX}@x.test`;
const JSON_HEADERS = { accept: 'application/json' };
const REFERER = 'http://localhost:7000/login';

function buildApp() {
  const app = Fastify();
  registerApiGuestRoutes(app);
  return app;
}

async function userByEmail(email: string) {
  return db.selectFrom('os_users').selectAll().where('email', '=', email).executeTakeFirst();
}

async function insertUser(password = 'oldpass1') {
  await db
    .insertInto('os_users')
    .values({ username: PREFIX, email: EMAIL, password: hashPassword(password), confirmation_code: '', created_at: nowDb() as never } as never)
    .execute();
}

beforeEach(() => {
  delete process.env.MAIL_ENABLED;
  loginThrottleClear(throttleKey(EMAIL, '127.0.0.1'));
});

afterEach(async () => {
  await db.deleteFrom('os_password_resets').where('email', 'like', `${PREFIX}%`).execute();
  await db.deleteFrom('os_users').where('email', 'like', `${PREFIX}%`).execute();
});

describe('POST /api/login', () => {
  it('validation: JSON 422 error arrays, otherwise 302 back to the referer', async () => {
    const app = buildApp();
    const json = await app.inject({ method: 'POST', url: '/api/login', headers: JSON_HEADERS, payload: {} });
    expect(json.statusCode).toBe(422);
    expect(json.json()).toEqual({ email: ['The email field is required.'], password: ['The password field is required.'] });
    const plain = await app.inject({ method: 'POST', url: '/api/login', headers: { referer: REFERER }, payload: {} });
    expect(plain.statusCode).toBe(302);
    expect(plain.headers['location']).toBe(REFERER);
    await app.close();
  });

  it('wrong password: 422 {email: auth.failed}; locks out with 423 after 5 failures', async () => {
    const app = buildApp();
    // own email: the lockout (not cleared by clear()) must not leak into the other tests
    const attempt = () =>
      app.inject({ method: 'POST', url: '/api/login', headers: JSON_HEADERS, payload: { email: `${PREFIX}lock@x.test`, password: 'nope' } });
    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ email: 'These credentials do not match our records.' });
    }
    const locked = await attempt();
    expect(locked.statusCode).toBe(423);
    expect(locked.json().email).toMatch(/^Too many login attempts\. Please try again in \d+ seconds\.$/);
    await app.close();
  });

  it('correct password: 500 (no session on the api group), remember token only stored with `remember`', async () => {
    await insertUser();
    const app = buildApp();
    const ok = await app.inject({ method: 'POST', url: '/api/login', headers: JSON_HEADERS, payload: { email: EMAIL, password: 'oldpass1' } });
    expect(ok.statusCode).toBe(500);
    expect((await userByEmail(EMAIL))?.remember_token).toBeNull();
    await app.inject({ method: 'POST', url: '/api/login', payload: { email: EMAIL, password: 'oldpass1', remember: 'on' } });
    expect((await userByEmail(EMAIL))?.remember_token).toHaveLength(60);
    await app.close();
  });
});

describe('removed guest endpoints', () => {
  it('has no /api/register or /api/password/* (admins manage users; no self-service reset)', async () => {
    await insertUser();
    const app = buildApp();
    for (const url of ['/api/register', '/api/password/email', '/api/password/reset']) {
      const res = await app.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: { name: 'A', email: EMAIL, password: 'secret1', password_confirmation: 'secret1', token: 'x' } });
      expect(res.statusCode, url).toBe(404);
    }
    // nothing was created or changed, and no reset token row was written
    expect(await db.selectFrom('os_password_resets').select('email').where('email', '=', EMAIL).execute()).toHaveLength(0);
    expect(verifyPassword('oldpass1', String((await userByEmail(EMAIL))?.password))).toBe(true);
    await app.close();
  });
});
