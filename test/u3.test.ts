// U3: product marketplace links/imports. Read-only checks; no marketplace calls, no DB writes.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';

let adminId = 0;

function buildApp(withUser: boolean) {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerUnshippedRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (withUser) (req.session as Record<string, unknown>)['user_id'] = adminId;
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
  adminId = row?.id ?? 0;
});
afterAll(async () => { await db.destroy(); });

// /unshipped90 is excluded: it queries hwc.products, which this dev DB lacks (the old app 500s too).
const PAGES = ['/unshippedFaire', '/unshipped91', '/unshipped92', '/unshipped101'];

describe("U3 pages", () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    for (const url of PAGES) expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(302);
    await app.close();
  });

  it('Faire and stores 91/92/101 render', async () => {
    const app = buildApp(true);
    for (const url of PAGES) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    }
    await app.close();
  }, 60000);
});
