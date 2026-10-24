// U5: summary / processed / searchOrder / PackingList / allunshipped / PendingShipment (read-only).
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins, strtotime, date } from '../src/view.js';

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
afterAll(async () => {
  await db.destroy();
});

const GETS = ['/summary', '/processed', '/allunshipped', '/PackingList', '/PendingShipment'];

describe('U5 pages', () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    for (const url of [...GETS, '/geturls', '/createPacking']) expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(302);
    expect((await app.inject({ method: 'POST', url: '/searchOrder' })).statusCode).toBe(302);
    await app.close();
  });

  it('list pages render', async () => {
    const app = buildApp(true);
    for (const url of GETS) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    }
    await app.close();
  }, 120000);

  it('geturls (missing controller method) and createPacking (missing view) are 500 like the old app', async () => {
    const app = buildApp(true);
    expect((await app.inject({ method: 'GET', url: '/geturls' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/createPacking' })).statusCode).toBe(500);
    await app.close();
  });

  it('searchOrder returns orders with detail + tracking arrays, newest first, max 200', async () => {
    const app = buildApp(true);
    const res = await app.inject({ method: 'POST', url: '/searchOrder', payload: 'orderId=11', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeLessThanOrEqual(200);
    for (const r of rows) {
      expect(String(r['orderId'])).toContain('11');
      expect(Array.isArray(r['detail'])).toBe(true);
      expect(Array.isArray(r['tracking'])).toBe(true);
    }
    const stamps = rows.map((r) => String(r['updated_at']));
    expect(stamps).toEqual([...stamps].sort().reverse());
    await app.close();
  });
});

describe('view strtotime (PHP relative formats)', () => {
  it('handles absolute, relative days/weekdays and ISO-with-zone', () => {
    expect(date('Y-m-d', strtotime('2025-08-04 10:00:00 + 3 days'))).toBe('2025-08-07');
    expect(date('Y-m-d', strtotime('2025-08-04 - 2 days'))).toBe('2025-08-02');
    expect(date('Y-m-d', strtotime('2025-08-01 + 3 weekdays'))).toBe('2025-08-06'); // Fri + 3 weekdays = Wed
    expect(date('Y-m-d', strtotime('2025-08-04T02:00:00.000Z'))).toBe('2025-08-03'); // UTC -> America/New_York
    expect(strtotime('')).toBe(0);
  });
});
