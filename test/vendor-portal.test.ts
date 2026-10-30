// Vendor users + portal: admin creates logins, vendors only see/edit/delete their own products,
// and vendor users are locked out of everything but /vendor/*. Temp rows (ZZ*), removed in afterAll.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fp from 'fastify-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireLogin, verifyPassword } from '../src/auth.js';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { disk } from '../src/storage.js';
import { registerProductRoutes } from '../src/modules/product/routes.js';
import { registerVendorRoutes } from '../src/modules/vendor/routes.js';
import { registerVendorUserRoutes } from '../src/modules/vendor/users.js';
import { registerVendorPortalRoutes } from '../src/modules/vendor/portal.js';
import { vendorLockdown, vendorPathAllowed } from '../src/vendorAccess.js';
import { registerViewPlugins } from '../src/view.js';

let adminId = 0;
const VA = 'ZZ Portal Vendor A';
const VB = 'ZZ Portal Vendor B';
const SKUS = ['ZZPA1', 'ZZPA2', 'ZZPB1', 'ZZPNEW'];
const NAMES = ['ZZ portal A1', 'ZZ portal A2', 'ZZ portal B1', 'ZZ portal new', 'ZZ portal new renamed'];
const USERS = ['zzvendora', 'zzvendorb'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function buildApp() {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(fp(multipart), { attachFieldsToBody: false });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  // test hook: log in as the user id in x-test-user (the real app uses the session cookie).
  app.addHook('preHandler', async (req) => {
    const id = Number(req.headers['x-test-user'] ?? 0);
    if (id) (req.session as Record<string, unknown>)['user_id'] = id;
  });
  app.addHook('preHandler', vendorLockdown);
  app.get('/zz-login-only', { preHandler: [requireLogin] }, async () => 'secret');
  registerProductRoutes(app);
  registerVendorRoutes(app);
  registerVendorUserRoutes(app);
  registerVendorPortalRoutes(app);
  return app;
}
type App = ReturnType<typeof buildApp>;

const form = (app: App, url: string, as: number, payload: Record<string, string> = {}, method: 'POST' | 'DELETE' = 'POST') =>
  app.inject({ method, url, payload: new URLSearchParams(payload).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-user': String(as) } });
const get = (app: App, url: string, as: number) => app.inject({ method: 'GET', url, headers: { 'x-test-user': String(as) } });

function multipartBody(fieldname: string, filename: string, content: Buffer) {
  const boundary = '----zzboundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function cleanup() {
  const prods = await db.selectFrom('os_products').select(['id']).where('sku', 'in', SKUS).execute();
  for (const p of prods) {
    const imgs = await db.selectFrom('os_product_images').select('filename').where('product_id', '=', String(p.id)).execute();
    for (const i of imgs) for (const d of ['product_image_full', 'product_image_icon']) await disk(d).delete(i.filename).catch(() => false);
    await db.deleteFrom('os_product_images').where('product_id', '=', String(p.id)).execute();
    await db.deleteFrom('os_product_locations').where('product_id', '=', p.id as never).execute();
  }
  await db.deleteFrom('os_products').where('sku', 'in', SKUS).execute();
  await db.deleteFrom('os_products').where('name', 'in', NAMES).execute();
  await db.deleteFrom('os_sku_vendors').where('sku', 'in', SKUS).execute();
  const users = await db.selectFrom('os_users').select('id').where('username', 'in', USERS).execute();
  for (const u of users) await db.deleteFrom('os_user_has_roles').where('user_id', '=', u.id).execute();
  await db.deleteFrom('os_users').where('username', 'in', USERS).execute(); // cascades os_vendor_users
  await db.deleteFrom('os_vendors').where('name', 'in', [VA, VB]).execute();
}

beforeAll(async () => {
  const row = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id')
    .where('os_roles.name', '=', 'admin')
    .executeTakeFirst();
  adminId = row?.id ?? 0;
  await cleanup();
});
afterAll(cleanup);

describe('vendorPathAllowed', () => {
  it('allows only the portal, login/logout and static assets', () => {
    for (const [m, p] of [['GET', '/vendor'], ['POST', '/vendor/products/3'], ['GET', '/login'], ['POST', '/logout'], ['GET', '/js/app.js'], ['GET', '/storage/product_images_icon/a.jpg']] as const) expect(vendorPathAllowed(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [['GET', '/ListProducts'], ['GET', '/api/products'], ['POST', '/api/vendors'], ['GET', '/home'], ['GET', '/vendors'], ['GET', '/vendorX'], ['POST', '/x/y.js'], ['GET', '/summary']] as const) expect(vendorPathAllowed(m, p), `${m} ${p}`).toBe(false);
  });
});

describe('vendor users + portal', () => {
  it('admin creates vendor logins; vendors are isolated; vendor users are locked down', async () => {
    const app = buildApp();

    // vendors + logins (admin only)
    const a = (await form(app, '/api/vendors', adminId, { name: VA })).json().id as number;
    const b = (await form(app, '/api/vendors', adminId, { name: VB })).json().id as number;
    expect((await form(app, `/api/vendors/${a}/users`, adminId, { username: 'zzvendora', email: 'bad', password: 'longenough1' })).statusCode).toBe(422);
    expect((await form(app, `/api/vendors/${a}/users`, adminId, { username: 'zzvendora', email: 'zza@example.com', password: 'short' })).statusCode).toBe(422);
    const ua = await form(app, `/api/vendors/${a}/users`, adminId, { username: 'zzvendora', email: 'zza@example.com', name: 'Vendor A', password: 'correct-horse-1' });
    expect(ua.statusCode).toBe(201);
    const ub = await form(app, `/api/vendors/${b}/users`, adminId, { username: 'zzvendorb', email: 'zzb@example.com', password: 'correct-horse-2' });
    expect(ub.statusCode).toBe(201);
    const uaId = ua.json().id as number;
    const ubId = ub.json().id as number;
    expect((await form(app, `/api/vendors/${a}/users`, adminId, { username: 'ZZVendorA', email: 'other@example.com', password: 'correct-horse-1' })).statusCode).toBe(409);
    expect((await form(app, `/api/vendors/${a}/users`, adminId, { username: 'zzother', email: 'zza@example.com', password: 'correct-horse-1' })).statusCode).toBe(409);
    const stored = await db.selectFrom('os_users').select(['password', 'confirmed']).where('id', '=', uaId).executeTakeFirst();
    expect(stored?.password).not.toBe('correct-horse-1');
    expect(verifyPassword('correct-horse-1', String(stored?.password))).toBe(true);
    const roles = await db.selectFrom('os_user_has_roles').innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id').select('os_roles.name').where('user_id', '=', uaId).execute();
    expect(roles.map((r) => r.name)).toEqual(['vendor']);
    expect((await get(app, `/api/vendors/${a}/users`, adminId)).json()).toEqual([{ id: uaId, username: 'zzvendora', name: 'Vendor A', email: 'zza@example.com' }]);
    // password reset
    expect((await form(app, `/api/vendor-users/${uaId}`, adminId, { password: 'brand-new-pass-9' })).json()).toEqual({ success: true });
    expect(verifyPassword('brand-new-pass-9', String((await db.selectFrom('os_users').select('password').where('id', '=', uaId).executeTakeFirst())?.password))).toBe(true);
    // a vendor user cannot use the admin APIs, even for their own vendor
    expect((await form(app, `/api/vendors/${a}/users`, uaId, { username: 'x', email: 'x@example.com', password: 'abcdefgh1' })).statusCode).toBe(403);
    expect((await get(app, '/api/vendors', uaId)).statusCode).toBe(403);
    // a vendor with logins cannot be deleted
    const blocked = await app.inject({ method: 'DELETE', url: `/api/vendors/${a}`, headers: { 'x-test-user': String(adminId) } });
    expect(blocked.statusCode).toBe(409);

    // ---- portal API as vendor A
    const api = (method: 'GET' | 'POST' | 'DELETE', url: string, as: number, body?: Record<string, unknown>) =>
      app.inject({ method, url: `/vendor/api${url}`, payload: body as never, headers: { 'x-test-user': String(as) } });
    expect((await api('GET', '/me', uaId)).json()).toEqual({ vendor_name: VA, username: 'zzvendora' });
    expect((await api('GET', '/products', uaId)).json()).toEqual({ total: 0, products: [] });
    expect((await get(app, '/vendor', uaId)).statusCode).toBe(200); // SPA shell
    expect((await get(app, '/vendor/products/new', uaId)).statusCode).toBe(200);

    const created = await api('POST', '/products', uaId, { name: 'ZZ portal A1', sku: 'ZZPA1', price: '12.5', description: 'hello', status: 'Active' });
    expect(created.statusCode).toBe(201);
    const a1 = created.json().id as number;
    expect(created.json()).toMatchObject({ sku: 'ZZPA1', name: 'ZZ portal A1', images: [] });
    expect(created.json()).not.toHaveProperty('cost');
    expect((await api('POST', '/products', uaId, { name: 'ZZ portal A2', sku: 'ZZPA2' })).statusCode).toBe(201);
    const b1 = (await api('POST', '/products', ubId, { name: 'ZZ portal B1', sku: 'ZZPB1' })).json().id as number;

    // assignment + audit fields
    expect(await db.selectFrom('os_sku_vendors').select('vendor_id').where('sku', '=', 'ZZPA1').executeTakeFirst()).toMatchObject({ vendor_id: a });
    expect(await db.selectFrom('os_products').select(['price', 'entry_by', 'status']).where('id', '=', a1).executeTakeFirst()).toMatchObject({ entry_by: 'vendor:zzvendora', status: 'Active' });

    // validation: duplicate sku / name, long sku, bad number
    const dupSku = await api('POST', '/products', uaId, { name: 'ZZ portal new', sku: 'ZZPB1' });
    expect(dupSku.statusCode).toBe(422);
    expect(dupSku.json().errors.sku).toBe('该 SKU 已被使用');
    expect((await api('POST', '/products', uaId, { name: 'ZZ portal A1', sku: 'ZZPNEW' })).json().errors.name).toBe('已存在同名产品');
    expect((await api('POST', '/products', uaId, { name: 'ZZ portal new', sku: 'X'.repeat(21) })).statusCode).toBe(422);
    expect((await api('POST', '/products', uaId, { name: 'ZZ portal new', sku: 'ZZPNEW', price: 'abc' })).json().errors.price).toBe('零售价必须是不小于 0 的数字');
    expect((await api('POST', '/products', uaId, { name: '', sku: 'ZZPNEW' })).statusCode).toBe(422);

    // list scoped to own products
    const listA = (await api('GET', '/products', uaId)).json() as { total: number; products: Array<{ sku: string }> };
    expect(listA.products.map((p) => p.sku).sort()).toEqual(['ZZPA1', 'ZZPA2']);
    expect(listA.total).toBe(2);
    expect(((await api('GET', '/products?q=ZZPA2', uaId)).json() as typeof listA).products.map((p) => p.sku)).toEqual(['ZZPA2']);

    // cross-vendor isolation: B cannot read/edit/delete/upload/delete-image on A's product
    expect((await api('GET', `/products/${a1}`, ubId)).statusCode).toBe(404);
    expect((await api('POST', `/products/${a1}`, ubId, { name: 'hijacked' })).statusCode).toBe(404);
    expect((await api('DELETE', `/products/${a1}`, ubId)).statusCode).toBe(404);
    expect((await api('DELETE', `/products/${a1}/images/1`, ubId)).statusCode).toBe(404);
    const mp = multipartBody('files[]', 'x.png', PNG);
    expect((await app.inject({ method: 'POST', url: `/vendor/api/products/${a1}/images`, payload: mp.payload, headers: { ...mp.headers, 'x-test-user': String(ubId) } })).statusCode).toBe(404);
    expect((await db.selectFrom('os_products').select('name').where('id', '=', a1).executeTakeFirst())?.name).toBe('ZZ portal A1');
    // a product that is not assigned to any vendor is invisible to vendors
    const internal = await db.insertInto('os_products').values({ name: 'ZZ portal new', sku: 'ZZPNEW', status: 'Active', created_at: nowDb(), updated_at: nowDb() } as never).executeTakeFirst();
    expect((await api('GET', `/products/${Number(internal.insertId)}`, uaId)).statusCode).toBe(404);
    expect((await api('DELETE', `/products/${Number(internal.insertId)}`, uaId)).statusCode).toBe(404);
    await db.deleteFrom('os_products').where('id', '=', Number(internal.insertId) as never).execute();

    // show / edit: sku and internal columns cannot be changed through the API
    expect((await api('GET', `/products/${a1}`, uaId)).json()).toMatchObject({ sku: 'ZZPA1', price: '12.50' });
    const upd = await api('POST', `/products/${a1}`, uaId, { name: 'ZZ portal new renamed', sku: 'HACKED', cost: '1', in_stock: '1', price: '20', weight: '40' });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ name: 'ZZ portal new renamed', sku: 'ZZPA1' });
    expect(await db.selectFrom('os_products').select(['name', 'sku', 'cost', 'weight']).where('id', '=', a1).executeTakeFirst()).toMatchObject({ name: 'ZZ portal new renamed', sku: 'ZZPA1', cost: null, weight: 40 });
    expect((await api('POST', `/products/${a1}`, uaId, { name: 'ZZ portal B1' })).statusCode).toBe(422); // name taken by B1

    // images (the regular uploader posts `files[]`; `files` works too)
    const up = multipartBody('files[]', 'pic.png', PNG);
    const upRes = await app.inject({ method: 'POST', url: `/vendor/api/products/${a1}/images`, payload: up.payload, headers: { ...up.headers, 'x-test-user': String(uaId) } });
    expect(upRes.statusCode).toBe(200);
    expect(upRes.json()).toMatchObject({ uploaded: 1, rejected: 0 });
    const bad = multipartBody('files', 'evil.php', Buffer.from('<?php echo 1;'));
    expect((await app.inject({ method: 'POST', url: `/vendor/api/products/${a1}/images`, payload: bad.payload, headers: { ...bad.headers, 'x-test-user': String(uaId) } })).json()).toMatchObject({ uploaded: 0, rejected: 1 });
    const imgs = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(a1)).execute();
    expect(imgs).toHaveLength(1);
    expect(await disk('product_image_full').exists(imgs[0].filename)).toBe(true);
    expect(await disk('product_image_icon').exists(imgs[0].filename)).toBe(true);
    expect(((await api('GET', `/products/${a1}`, uaId)).json() as { images: Array<{ filename: string }> }).images.map((i) => i.filename)).toEqual([imgs[0].filename]);
    expect((await api('DELETE', `/products/${a1}/images/${imgs[0].id}`, uaId)).json()).toEqual({ success: true });
    expect(await db.selectFrom('os_product_images').select('id').where('product_id', '=', String(a1)).execute()).toHaveLength(0);
    expect(await disk('product_image_full').exists(imgs[0].filename)).toBe(false);

    // delete: blocked with stock, allowed without
    const a2 = (await db.selectFrom('os_products').select('id').where('sku', '=', 'ZZPA2').executeTakeFirst())!.id as number;
    await db.insertInto('os_product_locations').values({ product_id: a2, location: 'ZZLOC1', qty: 3, created_at: nowDb(), updated_at: nowDb() } as never).execute();
    expect((await api('DELETE', `/products/${a2}`, uaId)).statusCode).toBe(409);
    expect(await db.selectFrom('os_products').select('id').where('id', '=', a2 as never).executeTakeFirst()).toBeTruthy();
    await db.deleteFrom('os_product_locations').where('product_id', '=', a2 as never).execute();
    expect((await api('DELETE', `/products/${a2}`, uaId)).json()).toEqual({ success: true });
    expect(await db.selectFrom('os_products').select('id').where('id', '=', a2 as never).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('os_sku_vendors').select('id').where('sku', '=', 'ZZPA2').executeTakeFirst()).toBeUndefined();

    // ---- lockdown: vendor users reach nothing but the portal
    for (const url of ['/ListProducts', '/home', '/', '/zz-login-only', '/Vendors', '/summary']) {
      const r = await get(app, url, uaId);
      expect(r.statusCode, url).toBe(302);
      expect(String(r.headers['location']), url).toMatch(/\/vendor$/);
    }
    for (const [url, method] of [['/api/products', 'GET'], ['/api/vendors', 'GET'], ['/api/products.update', 'POST'], ['/product/1/delete', 'GET']] as const) {
      const r = method === 'GET' ? await get(app, url, uaId) : await form(app, url, uaId);
      expect([302, 403], `${method} ${url}`).toContain(r.statusCode);
      expect(r.body, `${method} ${url}`).not.toContain('"products"');
    }
    expect((await form(app, '/api/product/1/vendor', uaId, { vendor_id: String(a) })).statusCode).toBe(403);
    // ...while non-vendor staff are unaffected and cannot use the portal
    expect((await get(app, '/zz-login-only', adminId)).statusCode).toBe(200);
    expect((await get(app, '/vendor', adminId)).statusCode).toBe(403);
    expect((await get(app, '/vendor/api/products', adminId)).statusCode).toBe(403);
    // anonymous -> login
    expect((await app.inject({ method: 'GET', url: '/vendor' })).statusCode).toBe(302);

    // deleting the login removes the user, role and link; then the vendor can be deleted
    expect((await app.inject({ method: 'DELETE', url: `/api/vendor-users/${uaId}`, headers: { 'x-test-user': String(adminId) } })).json()).toEqual({ success: true });
    expect(await db.selectFrom('os_users').select('id').where('id', '=', uaId).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('os_user_has_roles').select('user_id').where('user_id', '=', uaId).execute()).toHaveLength(0);
    // non-vendor users cannot be deleted through the vendor-user API
    expect((await app.inject({ method: 'DELETE', url: `/api/vendor-users/${adminId}`, headers: { 'x-test-user': String(adminId) } })).statusCode).toBe(404);
    expect(await db.selectFrom('os_users').select('id').where('id', '=', adminId).executeTakeFirst()).toBeTruthy();
    void b1;
    await app.close();
  });
});
