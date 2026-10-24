// U1: unshipped store pages 1–5 + enfloral. Guards (anon -> 302 /login) and
// 200 renders for the GET pages. The live angelisabella feed is stubbed via
// the service seam; refreshNotes (eBay Trading API + DB writes) is NOT
// exercised — calling it would hit the live eBay transport.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { setUnshipped3FetcherForTests } from '../src/modules/unshipped/service.js';
import { registerViewPlugins } from '../src/view.js';

let userId = 0;

function buildApp(withUser: boolean) {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerUnshippedRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (withUser) (req.session as Record<string, unknown>)['user_id'] = userId;
  });
  return app;
}

beforeAll(async () => {
  const row = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id')
    .where('os_roles.name', 'in', ['admin', 'user', 'remote'])
    .executeTakeFirst();
  userId = row?.id ?? 0;
  // Never let /unshipped3 hit the live angelisabella feed.
  setUnshipped3FetcherForTests(async () => JSON.stringify({ success: 1, orderitems: [] }));
});
afterAll(async () => {
  setUnshipped3FetcherForTests(null);
  await db.destroy();
});

describe('U1 guards', () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    for (const url of ['/unshipped1', '/unshipped2', '/unshipped3', '/unshipped4', '/unshipped5', '/enfloral']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(302);
      expect(String(res.headers.location)).toContain('/login');
    }
    await app.close();
  });
});

describe('U1 pages', () => {
  it('GET pages render', async () => {
    const app = buildApp(true);
    for (const url of ['/unshipped1', '/unshipped2', '/unshipped3', '/unshipped4', '/unshipped5', '/enfloral']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
    }
    await app.close();
  }, 30000);
});
