// guest:api routes (POST /api/login, /api/register, /api/password/email, /api/password/reset).
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

describe('POST /api/register', () => {
  it('validation errors incl. unique:users and confirmed/min', async () => {
    await insertUser();
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/register',
      headers: JSON_HEADERS,
      payload: { name: 'A', email: EMAIL, password: 'abc', password_confirmation: 'xyz' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      email: ['The email has already been taken.'],
      password: ['The password must be at least 6 characters.', 'The password confirmation does not match.'],
    });
    const bad = await app.inject({ method: 'POST', url: '/api/register', headers: JSON_HEADERS, payload: { email: 'not-an-email' } });
    expect(bad.json()).toEqual({
      name: ['The name field is required.'],
      email: ['The email must be a valid email address.'],
      password: ['The password field is required.'],
    });
    await app.close();
  });

  it('valid input: 500 (create() is commented out) and no user row is written', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { name: 'A', email: `${PREFIX}new@x.test`, password: 'secret1', password_confirmation: 'secret1' },
    });
    expect(res.statusCode).toBe(500);
    expect(await userByEmail(`${PREFIX}new@x.test`)).toBeUndefined();
    await app.close();
  });
});

describe('POST /api/password/email', () => {
  it('validation 422 JSON; unknown email 302 back without a token row', async () => {
    const app = buildApp();
    const bad = await app.inject({ method: 'POST', url: '/api/password/email', headers: JSON_HEADERS, payload: { email: 'x' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ email: ['The email must be a valid email address.'] });
    const unknown = await app.inject({ method: 'POST', url: '/api/password/email', headers: { ...JSON_HEADERS, referer: REFERER }, payload: { email: EMAIL } });
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers['location']).toBe(REFERER);
    expect(await db.selectFrom('os_password_resets').select('email').where('email', '=', EMAIL).execute()).toHaveLength(0);
    await app.close();
  });

  it('known email: 302 back, one bcrypt-hashed token row replacing the old one, no mail', async () => {
    await insertUser();
    const old = hashPassword('old-token');
    await db.insertInto('os_password_resets').values({ email: EMAIL, token: old, created_at: nowDb() as never } as never).execute();
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/password/email', headers: { referer: REFERER }, payload: { email: EMAIL } });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(REFERER);
    const rows = await db.selectFrom('os_password_resets').selectAll().where('email', '=', EMAIL).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].token).not.toBe(old);
    expect(rows[0].token).toMatch(/^\$2[aby]\$10\$/);
    await app.close();
  });
});

describe('POST /api/password/reset', () => {
  const TOKEN = 'a-reset-token';
  const payload = (over: Record<string, unknown> = {}) => ({
    email: EMAIL, token: TOKEN, password: 'newpass1', password_confirmation: 'newpass1', ...over,
  });
  const seedToken = (createdAt = nowDb()) =>
    db.insertInto('os_password_resets').values({ email: EMAIL, token: hashPassword(TOKEN), created_at: createdAt as never } as never).execute();

  it('validation: confirmed before min, token/email required', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/password/reset', headers: JSON_HEADERS, payload: { password: 'abc' } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      token: ['The token field is required.'],
      email: ['The email field is required.'],
      password: ['The password confirmation does not match.', 'The password must be at least 6 characters.'],
    });
    await app.close();
  });

  it('valid token: 302 /home, password changed, token rows deleted', async () => {
    await insertUser();
    await seedToken();
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/password/reset', payload: payload() });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/home$/);
    const user = await userByEmail(EMAIL);
    expect(verifyPassword('newpass1', user!.password)).toBe(true);
    expect(user!.remember_token).toHaveLength(60);
    expect(await db.selectFrom('os_password_resets').select('email').where('email', '=', EMAIL).execute()).toHaveLength(0);
    await app.close();
  });

  it('wrong/expired token or unknown user: 302 back, nothing changed', async () => {
    await insertUser();
    await seedToken();
    const app = buildApp();
    const headers = { referer: REFERER };
    for (const body of [payload({ token: 'wrong' }), payload({ email: `${PREFIX}nobody@x.test` })]) {
      const res = await app.inject({ method: 'POST', url: '/api/password/reset', headers, payload: body });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe(REFERER);
    }
    await db.updateTable('os_password_resets').set({ created_at: '2020-01-01 00:00:00' as never }).where('email', '=', EMAIL).execute();
    const expired = await app.inject({ method: 'POST', url: '/api/password/reset', headers, payload: payload() });
    expect(expired.headers['location']).toBe(REFERER);
    expect(verifyPassword('oldpass1', (await userByEmail(EMAIL))!.password)).toBe(true);
    expect(await db.selectFrom('os_password_resets').select('email').where('email', '=', EMAIL).execute()).toHaveLength(1);
    await app.close();
  });
});
