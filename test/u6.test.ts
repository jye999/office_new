// U6: order actions. Temp rows ZZU6T* are removed in afterAll; Pusher is stubbed; /clearCache (FLUSHDB) is not exercised.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// storage.ts reads STORAGE_DIR at import time; the real storage dir is not writable here.
const STORAGE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/u6-storage-${process.pid}`;
  process.env.STORAGE_DIR = dir;
  return dir;
});
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { setPusherClientForTests } from '../src/pusher.js';
import { originalIsEquivalent } from '../src/lib/eloquent.js';

let adminId = 0;
const events: Array<[string, string, unknown]> = [];
const PID = 990401;

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

async function cleanup() {
  await db.deleteFrom('os_trackings').where('orderId', '=', 'ZZU6T').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', '=', 'ZZU6T').execute();
  await db.deleteFrom('os_grant_order').where('orderId', '=', 'ZZU6T').execute();
  await db.deleteFrom('os_product_map').where('sku', '=', 'ZZU6TSKU').execute();
  await db.deleteFrom('os_product_locations').where('product_id', '=', PID as never).execute();
  await db.deleteFrom('os_products').where('id', '=', PID as never).execute();
}

let server: http.Server;
let labelUrl = '';
const labelFile = path.join(STORAGE, 'app/public/labels/labels/ZZU6T.png');

beforeAll(async () => {
  setPusherClientForTests({ trigger: async (c: string, e: string, d: unknown) => void events.push([c, e, d]) } as never);
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
  await db.insertInto('os_products').values({ id: PID, sku: 'ZZU6TSKU', name: 'zz', created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_product_locations').values([{ id: 990411, product_id: PID, location: 'A1B1L1', qty: 10, created_at: now, updated_at: now }] as never).execute();
  await db.insertInto('os_product_map').values({ sku: 'ZZU6TSKU', store: 'T', externalId: 'ZZU6TEXT', qty: 2, created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_grant_order').values({ id: 900401, store: 'T', orderId: 'ZZU6T', buyer: 'b', created_at: now, updated_at: now } as never).execute();
  await db
    .insertInto('os_grant_orderdetail')
    .values({ id: 900401, store: 'T', orderId: 'ZZU6T', subOrderId: 'S1', itemId: 'ZZU6TITEM', name: 'n', qty: 3, sku: 'ZZU6TEXT', created_at: now, updated_at: now } as never)
    .execute();
  server = http.createServer((_q, r) => r.end('PNGDATA'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  labelUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/l.png`;
});
afterAll(async () => {
  setPusherClientForTests(null);
  await cleanup();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  server.close();
  await db.destroy();
});

describe('U6 order actions', () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    expect((await post(app, '/madeOrder', { orderId: 'x' })).statusCode).toBe(302);
    await app.close();
  });

  it('made/progress toggle detail.made and trigger pusher; unknown ids are 500', async () => {
    const app = buildApp();
    const made = async () => (await db.selectFrom('os_grant_orderdetail').select('made').where('id', '=', 900401).executeTakeFirst())?.made;
    expect((await post(app, '/madeOrder', { orderId: 'ZZU6TITEM' })).body).toBe('"1"');
    expect(await made()).toBe('Y');
    expect((await post(app, '/madeOrder', { orderId: 'ZZU6TITEM' })).body).toBe('"0"');
    expect(await made()).toBeNull();
    expect((await post(app, '/madeOrder', { orderId: 'ZZU6TITEM', status: 'halfmade' })).body).toBe('"1"');
    expect(await made()).toBe('H');
    expect((await post(app, '/progressOrder', { orderId: '900401' })).body).toBe('"2"'); // falls back to id=intval()
    expect(await made()).toBe('P');
    expect((await post(app, '/progressOrder', { orderId: '900401' })).body).toBe('"0"');
    expect(events.map((e) => (e[2] as { status: number }).status)).toEqual([1, 0, 1, 2, 0]);
    expect((await post(app, '/madeOrder', { orderId: 'NOSUCHZZ' })).statusCode).toBe(500);
    await app.close();
  });

  it('notes / priority / assign / ship date / getOrder / getPriority', async () => {
    const app = buildApp();
    expect((await post(app, '/saveOrderNotes', { orderId: 'ZZU6TITEM', notes: 'hi' })).body).toBe('"ok"');
    expect((await post(app, '/priorityOrder', { orderId: 'ZZU6T', hp: '1' })).body).toBe('"Prioritize"');
    expect((await post(app, '/priorityOrder', { orderId: 'ZZU6T', hp: '2' })).body).toBe('"Urgent"');
    expect((await post(app, '/priorityOrder', { orderId: 'ZZU6T', hp: '0' })).body).toBe('""');
    expect((await post(app, '/assignOrder', { orderId: 'ZZU6T', subOrderId: 'S1', name: 'Ray' })).json()).toMatchObject({ assignedTo: 'Ray', notes: 'hi' });
    expect((await post(app, '/saveOrderShipDate', { orderId: 'ZZU6T', date: '2025-09-01' })).json()).toMatchObject({ planShipDate: '2025-09-01' });
    const o = (await post(app, '/getOrder', { orderId: 'ZZU6T' })).json();
    expect(o.detail).toHaveLength(1);
    expect((await post(app, '/getOrder', { orderId: 'NOSUCHZZ' })).body).toBe('{}');
    expect((await post(app, '/getPriority', { orderId: 'ZZU6T' })).json().orderId).toBe('ZZU6T');
    expect((await post(app, '/getPriority', { orderId: 'NOSUCHZZ' })).body).toBe('');
    expect((await post(app, '/assignOrder', { orderId: 'NOSUCHZZ', name: 'x' })).statusCode).toBe(500);
    await app.close();
  });

  it('updateOrder stores tracking + label, submits the order and deducts stock; doneOrder closes it', async () => {
    const app = buildApp();
    const res = await post(app, '/updateOrder', { orderId: 'ZZU6T', store: 'T', tracking: ' 94 00\n11 ', url: labelUrl, pendingToship: '1', amount: '3.5' });
    expect(res.json(), res.body).toEqual({ status: 'ok', orderId: 'ZZU6T' });
    const t = await db.selectFrom('os_trackings').selectAll().where('orderId', '=', 'ZZU6T').executeTakeFirstOrThrow();
    expect([t.tracking, t.Url, t.localUrl, t.store]).toEqual(['940011', labelUrl, 'ZZU6T.png', 'T']);
    expect(fs.readFileSync(labelFile, 'utf8')).toBe('PNGDATA');
    const order = await db.selectFrom('os_grant_order').select(['status', 'PendingShipment']).where('orderId', '=', 'ZZU6T').executeTakeFirstOrThrow();
    expect([order.status, order.PendingShipment]).toEqual(['submit', 1]);
    // qty 3 x map qty 2 = 6 off the first bin that holds more than the map qty
    expect((await db.selectFrom('os_product_locations').select('qty').where('id', '=', 990411).executeTakeFirstOrThrow()).qty).toBe(4);
    expect((await post(app, '/updateOrder', { orderId: 'NOSUCHZZ', tracking: 'Q' })).json()).toEqual({ status: 'failed', orderId: 'not found' });
    await db.deleteFrom('os_trackings').where('orderId', '=', 'NOSUCHZZ').execute();
    expect((await post(app, '/doneOrder', { orderId: 'ZZU6T' })).body).toBe('"ok"');
    expect((await db.selectFrom('os_grant_order').select(['status', 'PendingShipment']).where('orderId', '=', 'ZZU6T').executeTakeFirstOrThrow())).toEqual({ status: 'Done', PendingShipment: 0 });
    expect((await post(app, '/doneOrder', { orderId: 'NOSUCHZZ' })).body).toBe('"error"');
    await app.close();
  }, 30000);

  it('a failing label download aborts updateOrder with 500 and saves no tracking', async () => {
    const app = buildApp();
    const res = await post(app, '/updateOrder', { orderId: 'ZZU6T', tracking: 'NOPE', url: 'http://127.0.0.1:1/x.png' });
    expect(res.statusCode).toBe(500);
    expect(await db.selectFrom('os_trackings').select('Id').where('tracking', '=', 'NOPE').execute()).toHaveLength(0);
    await app.close();
  });

  it('submittedOrder renders', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/submittedOrder' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('eloquent originalIsEquivalent', () => {
  it('follows Laravel 5.4', () => {
    expect(originalIsEquivalent('1', 1)).toBe(true);
    expect(originalIsEquivalent('', null)).toBe(false);
    expect(originalIsEquivalent(null, null)).toBe(true);
    expect(originalIsEquivalent('abc', 'abd')).toBe(false);
  });
});
