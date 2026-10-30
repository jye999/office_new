// Regression: POST /logout must actually end the session (the session proxy ignores `delete session[k]`).
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, requireLogin } from '../src/auth.js';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { registerAuthRoutes } from '../src/modules/auth/routes.js';
import { installRouter } from '../src/router.js';
import { registerViewPlugins } from '../src/view.js';

const EMAIL = 'zzlogouttest@example.com';
const PASSWORD = 'logout-test-pass-1';

function buildApp() {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerAuthRoutes(app);
  app.get('/zz-private', { preHandler: [requireLogin] }, async () => 'private');
  return app;
}

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const sc = res.headers['set-cookie'];
  const first = (Array.isArray(sc) ? sc[0] : String(sc ?? '')) as string;
  return first.split(';')[0];
};

async function cleanup() {
  await db.deleteFrom('os_users').where('email', '=', EMAIL).execute();
}
beforeAll(async () => {
  await cleanup();
  await db.insertInto('os_users').values({ username: 'zzlogouttest', email: EMAIL, password: hashPassword(PASSWORD), confirmation_code: '', confirmed: 1, created_at: nowDb(), updated_at: nowDb() } as never).execute();
});
afterAll(cleanup);

describe('logout', () => {
  it('login, then logout clears the session cookie and the user is logged out', async () => {
    const app = buildApp();
    const login = await app.inject({ method: 'POST', url: '/login', payload: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(login.statusCode).toBe(302);
    const cookie = cookieOf(login);
    expect(cookie).toMatch(/^office_session=.+/);
    expect((await app.inject({ method: 'GET', url: '/zz-private', headers: { cookie } })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(out.statusCode).toBe(302);
    const setCookie = String(([] as unknown[]).concat(out.headers['set-cookie'])[0]);
    expect(setCookie).toMatch(/^office_session=;/);
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970/);

    // a browser honours the expired cookie, so the next request is anonymous
    const after = await app.inject({ method: 'GET', url: '/zz-private' });
    expect(after.statusCode).toBe(302);
    expect(String(after.headers['location'])).toMatch(/\/login$/);
    await app.close();
  });
});
