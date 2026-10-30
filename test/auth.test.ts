import { createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  loginThrottleAvailableIn,
  loginThrottleClear,
  loginThrottleHit,
  loginThrottleTooMany,
  passportApiAuth,
  pdaAuth,
  requireRoles,
  verifyPassword,
} from '../src/auth.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerAuthRoutes } from '../src/modules/auth/routes.js';
import { installRouter } from '../src/router.js';
import { registerViewPlugins } from '../src/view.js';

// ---------------------------------------------------------------- bcrypt $2y$

describe('verifyPassword (Laravel $2y$ hashes)', () => {
  it('verifies a $2y$-prefixed hash of a freshly generated one', () => {
    const hash = hashPassword('secret1');
    expect(hash).toMatch(/^\$2[aby]\$/);
    const y = hash.replace(/^\$2[aby]\$/, '$2y$');
    expect(verifyPassword('secret1', y)).toBe(true);
    expect(verifyPassword('secret2', y)).toBe(false);
  });

  it('rejects garbage hashes', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

// ---------------------------------------------------------------- login throttle

describe('login throttle (5 tries/min, in-memory)', () => {
  it('allows 5 failures then locks out for 60s', () => {
    const key = 'a@example.com|1.2.3.4';
    for (let i = 0; i < 4; i++) {
      loginThrottleHit(key, 1000);
      expect(loginThrottleTooMany(key, 1000)).toBe(false);
    }
    loginThrottleHit(key, 1000); // 5th
    expect(loginThrottleTooMany(key, 2000)).toBe(true); // lockout triggered
    expect(loginThrottleAvailableIn(key, 2000)).toBe(60);
    expect(loginThrottleTooMany(key, 61_999)).toBe(true); // still locked out
    expect(loginThrottleTooMany(key, 62_001)).toBe(false); // lockout expired, counter reset
  });

  it('clear() on success resets the counter but not an active lockout', () => {
    const key = 'b@example.com|1.2.3.4';
    for (let i = 0; i < 5; i++) loginThrottleHit(key, 1000);
    loginThrottleTooMany(key, 2000);
    loginThrottleClear(key, 2000);
    expect(loginThrottleTooMany(key, 3000)).toBe(true);
  });

  it('counter window decays after 60s', () => {
    const key = 'c@example.com|1.2.3.4';
    for (let i = 0; i < 4; i++) loginThrottleHit(key, 1000);
    loginThrottleHit(key, 62_000); // window rolled over -> 1
    expect(loginThrottleTooMany(key, 63_000)).toBe(false);
  });
});

// ---------------------------------------------------------------- app harness

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return typeof raw === 'string' ? raw.split(';')[0] : Array.isArray(raw) ? raw[0].split(';')[0] : '';
}

describe('auth routes (fastify inject)', () => {
  it('role guard: no user -> 302 /login with intended, user w/o role -> 403 No Access.', async () => {
    const { db } = await import('../src/db.js');
    const realUser = await db.selectFrom('os_users').select('id').executeTakeFirst();
    if (!realUser) throw new Error('no users in DB');

    const app = Fastify();
    await app.register(formbody);
    await app.register(registerHttpHelpers);
    await registerViewPlugins(app);
    // simulate a logged-in user who has none of the requested roles; registered
    // before the route so this preHandler runs before the guard's
    app.addHook('preHandler', async (req) => {
      (req.session as Record<string, unknown>)['user_id'] = realUser.id;
    });
    app.get('/secret', { preHandler: [requireRoles(['no_such_role_t02'])] }, async () => 'ok');
    const loggedOut = await app.inject({ method: 'GET', url: '/secret' });
    expect(loggedOut.statusCode).toBe(403);
    expect(loggedOut.body).toBe('No Access.');

    const anonApp = Fastify();
    await registerViewPlugins(anonApp);
    anonApp.get('/secret2', { preHandler: [requireRoles(['admin'])] }, async () => 'ok');
    const anon = await anonApp.inject({ method: 'GET', url: '/secret2' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers['location']).toBe('http://localhost:80/login'); // Laravel sends absolute Location
    await app.close();
    await anonApp.close();
  });

  it('GET /login renders the login form; GET / redirects to /login when anonymous', async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(registerHttpHelpers);
    await registerViewPlugins(app);
    registerAuthRoutes(app);

    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('panel-heading">Login');
    expect(res.body).toContain('name="email"');
    expect(res.body).toContain('name="password"');

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(302);
    expect(home.headers['location']).toBe('http://localhost:80/login');
    await app.close();
  });

  it('POST /login validation failure -> back with required errors, shown once', async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(registerHttpHelpers);
    await registerViewPlugins(app);
    registerAuthRoutes(app);

    const post = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: '', password: '' },
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers['location']).toBe('http://localhost:80/'); // no Referer -> app root
    const cookie = cookieOf(post);
    expect(cookie).toContain('office_session=');

    const page = await app.inject({ method: 'GET', url: '/login', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('The email field is required.');
    expect(page.body).toContain('The password field is required.');

    // flash consumed: the render cleared it, so page's set-cookie carries the clean session
    const page2 = await app.inject({ method: 'GET', url: '/login', headers: { cookie: cookieOf(page) || cookie } });
    expect(page2.body).not.toContain('field is required');
    await app.close();
  });

  it('POST /login bad password -> back with auth.failed and old email', async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(registerHttpHelpers);
    await registerViewPlugins(app);
    registerAuthRoutes(app);

    const post = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { referer: 'http://localhost:7000/login' },
      payload: { email: 'office@angelisabella.com', password: 'definitely-wrong' },
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers['location']).toBe('http://localhost:7000/login');
    const cookie = cookieOf(post);

    const page = await app.inject({ method: 'GET', url: '/login', headers: { cookie } });
    expect(page.body).toContain('These credentials do not match our records.');
    expect(page.body).toContain('value="office@angelisabella.com"');
    await app.close();
  });

  it('pdaAuth: 401 bodies for missing/invalid keys', async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(registerHttpHelpers);
    await registerViewPlugins(app);
    app.get('/p', { preHandler: [pdaAuth] }, async () => 'ok');

    expect((await app.inject({ method: 'GET', url: '/p' })).body).toBe('{"message":"API key required"}');
    expect(
      (await app.inject({ method: 'GET', url: '/p', headers: { 'x-api-key': 'no-such-key-123' } })).body,
    ).toBe('{"message":"Invalid API key"}');
    expect(
      (await app.inject({ method: 'GET', url: '/p', headers: { authorization: 'Bearer no-such-key-123' } })).body,
    ).toBe('{"message":"Invalid API key"}');
    await app.close();
  });

  it('passportApiAuth: 401 Unauthenticated for missing/garbled/tampered JWTs', async () => {
    const app = Fastify();
    await registerViewPlugins(app);
    app.get('/u', { preHandler: [passportApiAuth] }, async () => 'ok');

    const none = await app.inject({ method: 'GET', url: '/u' });
    expect(none.body).toBe('{"message":"Unauthenticated"}');

    const garbage = await app.inject({ method: 'GET', url: '/u', headers: { authorization: 'Bearer not.a.jwt' } });
    expect(garbage.body).toBe('{"message":"Unauthenticated"}');

    // a properly signed token (app's oauth private key) still 401s: no token row exists
    const privateKey = fs.readFileSync(path.join(process.cwd(), '..', 'office', 'storage', 'oauth-private.key'));
    const sign = (payload: object): string => {
      const b64 = (o: Buffer | object) =>
        (o instanceof Buffer ? o : Buffer.from(JSON.stringify(o))).toString('base64url');
      const head = b64({ alg: 'RS256', typ: 'JWT' });
      const body = b64(payload);
      const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey, 'base64url');
      return `${head}.${body}.${sig}`;
    };
    const good = await app.inject({
      method: 'GET',
      url: '/u',
      headers: { authorization: `Bearer ${sign({ psp: 'passport', id: 'no-such-token', sub: '1' })}` },
    });
    expect(good.body).toBe('{"message":"Unauthenticated"}');

    const tampered = sign({ psp: 'passport', id: 'x', sub: '1' });
    const [h, b, s] = tampered.split('.');
    const badSig = `${h}.${b}.${s.slice(0, -8)}AAAAAAAA`;
    const res = await app.inject({ method: 'GET', url: '/u', headers: { authorization: `Bearer ${badSig}` } });
    expect(res.body).toBe('{"message":"Unauthenticated"}');
    await app.close();
  });

  it('has no self-service registration or password reset (admins manage users)', async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(registerHttpHelpers);
    await registerViewPlugins(app);
    registerAuthRoutes(app);
    installRouter(app);
    for (const [method, url] of [['GET', '/register'], ['POST', '/register'], ['GET', '/password/reset'], ['POST', '/password/email'], ['POST', '/password/reset'], ['GET', '/password/reset/TOKEN123']] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // and the login page no longer links to them
    const login = await app.inject({ method: 'GET', url: '/login' });
    expect(login.body).not.toContain('/password/reset');
    expect(login.body).not.toContain('/register');
    await app.close();
  });
});
