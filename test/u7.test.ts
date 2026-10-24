// U7: labels + printing. Amazon / Houzz / redis are stubbed; label files live in a temp STORAGE_DIR; temp rows ZZU7* removed.
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/u7-storage-${process.pid}`;
  process.env.STORAGE_DIR = dir;
  return dir;
});

import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { setAmazonTransportForTests } from '../src/lib/amazonApi.js';
import { setHouzzTransportForTests } from '../src/lib/houzz.js';
import { setQueuePushForTests } from '../src/lib/queueJobs.js';

let adminId = 0;
const pushed: Array<[string, string]> = [];

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
  await db.deleteFrom('os_trackings').where('orderId', 'like', 'ZZU7%').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'ZZU7%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'ZZU7%').execute();
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
  setQueuePushForTests(async (payload, queue) => void pushed.push([queue, payload]));
  await cleanup();
  const now = nowDb() as unknown as Date;
  await db.insertInto('os_grant_order').values({ id: 900701, store: 'A', orderId: 'ZZU7A', created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_grant_orderdetail').values({ id: 900701, store: 'A', orderId: 'ZZU7A', itemId: 'OI1', name: 'n', qty: 1, created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_trackings').values([
    { orderId: 'ZZU7T', tracking: 'OLD', Url: 'u', created_at: now, updated_at: now },
    { orderId: 'ZZU7T', tracking: 'NEW', Url: 'u', created_at: now, updated_at: now },
  ] as never).execute();
});
afterAll(async () => {
  setQueuePushForTests(null);
  await cleanup();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  await db.destroy();
});
beforeEach(() => {
  delete process.env.DRY_RUN;
});
afterEach(() => {
  setAmazonTransportForTests(null);
  setHouzzTransportForTests(null);
  delete process.env.DRY_RUN;
});

describe('U7 read routes', () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    for (const u of ['/GetLabel', '/LabelCountReport', '/PrintShipping', '/Barcode', '/getOrderLabel']) expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(302);
    await app.close();
  });

  it('GetLabel returns the newest tracking row, {} when none', async () => {
    const app = buildApp();
    expect((await post(app, '/GetLabel', { orderId: 'ZZU7T' })).json().tracking).toBe('NEW');
    expect((await post(app, '/GetLabel', { orderId: 'NOSUCHZZ' })).body).toBe('{}');
    await app.close();
  });

  it('LabelCountReport has four {total} buckets; PrintShipping renders; Barcode is a 500 (view missing)', async () => {
    const app = buildApp();
    const r = (await app.inject({ method: 'GET', url: '/LabelCountReport' })).json();
    expect(Object.keys(r)).toEqual(['today', 'yesterday', 'seven', 'thirty']);
    expect(typeof r.thirty[0].total).toBe('number');
    expect((await app.inject({ method: 'GET', url: '/PrintShipping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/Barcode' })).statusCode).toBe(500);
    expect((await post(app, '/storeLabel', { orderId: 'a', url: 'b' })).statusCode).toBe(500);
    await app.close();
  });

  it('getOrderLabel serves png/gif/pdf from the labels disk (strips a leading #), else 404', async () => {
    const dir = path.join(STORAGE, 'app/public/labels/labels');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ZZU7P.png'), 'PNG');
    fs.writeFileSync(path.join(dir, 'ZZU7G.gif'), 'GIF');
    fs.writeFileSync(path.join(dir, 'ZZU7D.pdf'), 'PDF');
    fs.writeFileSync(path.join(dir, '#12.pdf'), 'SHORT');
    const app = buildApp();
    const get = (id: string) => app.inject({ method: 'GET', url: `/getOrderLabel?orderId=${encodeURIComponent(id)}` });
    let res = await get('#ZZU7P');
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'image/png', 'PNG']);
    res = await get('ZZU7G');
    expect([res.headers['content-type'], res.body]).toEqual(['image/gif', 'GIF']);
    res = await get('ZZU7D');
    expect([res.headers['content-type'], res.body]).toEqual(['application/pdf', 'PDF']);
    res = await get('12'); // <= 5 chars also tries labels/#<id>
    expect([res.headers['content-type'], res.body]).toEqual(['application/pdf', 'SHORT']);
    expect((await get('NOSUCHZZ')).statusCode).toBe(404);
    await app.close();
  });
});

describe('U7 actions (stubbed)', () => {
  it('mass print routes enqueue one Laravel job each and return an empty 200', async () => {
    const app = buildApp();
    pushed.length = 0;
    const a = await post(app, '/getMultiAmzLabel', { 'orders[0]': 'A1', 'orders[1]': 'A2', lb: '1', oz: '2', length: '3', width: '4', height: '5' });
    const f = await post(app, '/getMultiFrayunLabel', { 'orders[0]': 'F1', lb: '1', oz: '2', length: '3', width: '4', height: '5' });
    expect([a.statusCode, a.body, f.statusCode, f.body]).toEqual([200, '', 200, '']);
    expect(pushed.map(([q]) => q)).toEqual(['default', 'default']);
    const [pa, pf] = pushed.map(([, p]) => JSON.parse(p));
    expect(pa.displayName).toBe('App\\Jobs\\AmzMassPrintLabel');
    expect(pa.data.command).toContain('s:5:"\0*\0oz";i:18;'); // 2 + 1*16
    expect(pf.displayName).toBe('App\\Jobs\\FrayunMassPrintLabel');
    expect(pf.timeout).toBe(600);
    await app.close();
  });

  it('GetAmazonShippingLabel stores the label, closes the order and records the tracking (transport stubbed)', async () => {
    Object.assign(process.env, { AMZ_LWA_CLIENT_ID: 'c', AMZ_LWA_CLIENT_SECRET: 's', AMZ_LWA_REFRESH_TOKEN: 'r', AMZ_ACCESS_KEY_ID: 'k', AMZ_ACCESS_SECRET: 'x', AMZ_ROLE_ARN: 'arn:aws:iam::1:role/R' });
    setAmazonTransportForTests(async (req) => {
      const u = new URL(req.url);
      if (u.host === 'api.amazon.com') return { status: 200, body: JSON.stringify({ access_token: 'T', expires_in: 3600 }) };
      if (u.host.startsWith('sts.')) return { status: 200, body: JSON.stringify({ AssumeRoleResponse: { AssumeRoleResult: { Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: Math.floor(Date.now() / 1000) + 3600 } } } }) };
      return { status: 200, body: JSON.stringify({ payload: { ShipmentId: 'SH1', TrackingId: 'TR1', Label: { FileContents: { Contents: Buffer.from('LABELBYTES').toString('base64') } }, ShippingService: { Rate: { Amount: 5.1 } } } }) };
    });
    const app = buildApp();
    const res = await post(app, '/GetAmazonShippingLabel', { orderId: 'ZZU7A', lb: '1', oz: '2', length: '6', width: '6', height: '4', shippingServiceId: 'UPS_PTP_GROUND' });
    expect(res.json(), res.body).toMatchObject({ TrackingId: 'TR1', ShipmentId: 'SH1' });
    expect(fs.readFileSync(path.join(STORAGE, 'app/public/labels/labels/ZZU7A.png'), 'utf8')).toBe('LABELBYTES');
    expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'ZZU7A').executeTakeFirstOrThrow()).status).toBe('Done');
    const t = await db.selectFrom('os_trackings').selectAll().where('orderId', '=', 'ZZU7A').executeTakeFirstOrThrow();
    expect([t.tracking, t.Url, t.localUrl, t.store]).toEqual(['TR1', 'SH1', 'ZZU7A.png', 'A']);
    await app.close();
  });

  it('DRY_RUN=1 turns the label purchase and the Houzz ship call into 500s without any outbound call', async () => {
    process.env.DRY_RUN = '1';
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const out: string[] = [];
    setAmazonTransportForTests(async (r) => (out.push(r.url), { status: 500, body: '{}' }));
    setHouzzTransportForTests(async (r) => (out.push(String(r.url)), '{}'));
    const app = buildApp();
    expect((await post(app, '/GetAmazonShippingLabel', { orderId: 'ZZU7A', shippingServiceId: 'X' })).statusCode).toBe(500);
    expect((await post(app, '/ShipHouzzOrder', { orderId: 'H1' })).statusCode).toBe(500);
    expect(out).toEqual([]);
    vi.restoreAllMocks();
    await app.close();
  });
});
