// U8: tracking routes. Temp rows ZZU8T* are removed in afterAll. UploadTracking (retired MWS feed) is a 500.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';

let adminId = 0;
function buildApp(withUser = true) {
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
const post = (app: ReturnType<typeof buildApp>, url: string, p: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload: new URLSearchParams(p).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const cleanup = async () => {
  await db.deleteFrom('os_trackings').where('orderId', 'like', 'ZZU8T%').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'ZZU8T%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'ZZU8T%').execute();
};

beforeAll(async () => {
  const row = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id')
    .where('os_roles.name', 'in', ['admin', 'user', 'remote'])
    .executeTakeFirst();
  adminId = row?.id ?? 0;
  await cleanup();
  const now = nowDb() as unknown as Date;
  await db.insertInto('os_grant_order').values({ id: 900851, store: 'A', orderId: 'ZZU8TA', buyer: 'b', created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_trackings').values([
    { orderId: 'ZZU8TA', store: 'A', tracking: 'T-OK', Url: 'u', stampsTxId: 'tx-abc', created_at: now, updated_at: now },
    { orderId: 'ZZU8TA', store: 'A', tracking: 'T-EMPTY', Url: 'u', stampsTxId: '', created_at: now, updated_at: now },
    { orderId: 'ZZU8TA', store: 'A', tracking: 'T-VOID', Url: 'u', stampsTxId: 'tx-v', voided: 1, created_at: now, updated_at: now },
  ] as never).execute();
});
afterAll(async () => {
  await cleanup();
  await db.destroy();
});

describe('U8 tracking', () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    for (const u of ['/trackings', '/trackingsAjax', '/scanform']) expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(302);
    await app.close();
  });

  it('SearchTracking / trackingsAjax (filter, sort, paginate, CORS) / pages', async () => {
    const app = buildApp();
    expect((await post(app, '/SearchTracking', { orderId: 'ZZU8TA' })).json()).toHaveLength(3);
    expect((await post(app, '/SearchTracking', { tracking: 'T-OK' })).json()).toHaveLength(1);
    expect((await post(app, '/SearchTracking', { orderId: 'ZZ' })).json()).toEqual([]);
    const ajax = await app.inject({ method: 'GET', url: '/trackingsAjax?filter=ZZU8TA&per_page=2&sort=tracking%7Casc' });
    const j = ajax.json();
    expect([j.total, j.per_page, j.data.map((r: { tracking: string }) => r.tracking)]).toEqual([3, 2, ['T-EMPTY', 'T-OK']]);
    expect(ajax.headers['access-control-allow-origin']).toBe('*');
    expect((await app.inject({ method: 'GET', url: '/trackingsAjax?sort=tracking' })).statusCode).toBe(500); // list() without '|'
    expect((await app.inject({ method: 'GET', url: '/trackingsAjax?filter=ZZU8TA&sort=tracking%7Csideways' })).statusCode).toBe(200); // 5.4: not asc -> desc
    expect((await app.inject({ method: 'GET', url: '/trackings' })).statusCode).toBe(200);
    const scan = await app.inject({ method: 'GET', url: '/scanform' });
    expect(scan.statusCode).toBe(200);
    expect(scan.body).toContain('TX-ABC'); // upper-cased stampsTxId; empty and voided rows are skipped
    expect(scan.body).not.toContain('TX-V');
    await app.close();
  });

  it('eBay/Amazon tracking writes and removeTracking', async () => {
    const app = buildApp();
    expect((await post(app, '/updateEbayTracking', { orderId: 'ZZU8TE', tracking: 'E1', url: 'u', stampsTxId: 's' })).json()).toBe('OK');
    expect((await post(app, '/updateAmzTracking', { orderId: 'ZZU8TA', tracking: 'AMZ', url: 'u', rate: encodeURIComponent('{"ServiceType":"US-FC"}') })).json()).toBe('ok');
    expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'ZZU8TA').executeTakeFirstOrThrow()).status).toBe('Done');
    expect((await post(app, '/updateAmzTracking', { orderId: 'ZZU8TA', tracking: 'x' })).statusCode).toBe(500); // no rate -> undefined index
    expect((await post(app, '/updateAmzTracking', { orderId: 'NOSUCHZZ', tracking: 'x', rate: '{"ServiceType":"a"}' })).body).toBe('');
    // NOT NULL Url omitted: works because the pools run in the old app's non-strict sql_mode
    expect((await post(app, '/uploadAmzTracking', { orderId: 'ZZU8TA', tracking: 'UP' })).json()).toBe('ok');
    expect((await post(app, '/uploadAmzTracking', { orderId: 'NOSUCHZZ', tracking: 'x' })).json()).toBe(0);
    expect((await post(app, '/removeTracking', { orderId: 'ZZU8TE' })).body).toBe('1');
    expect((await post(app, '/removeTracking', { orderId: 'NOSUCHZZ' })).body).toBe('0');
    expect((await post(app, '/UploadTracking', {})).statusCode).toBe(500);
    await app.close();
  });
});
