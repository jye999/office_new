// Vendors: /Vendors page, /api/vendors CRUD, per-product assignment and the vendor fields on /api/products.
// Writes use temp rows (ZZ vendor / ZZVENDSKU), removed in afterAll.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerProductRoutes } from '../src/modules/product/routes.js';
import { registerVendorRoutes } from '../src/modules/vendor/routes.js';
import { registerViewPlugins } from '../src/view.js';

let adminId = 0;
const PID = 990201;
const SKU = 'ZZVENDSKU';
const NAMES = ['ZZ Vendor A', 'ZZ Vendor B', 'ZZ Vendor A2'];

function buildApp(withUser: boolean) {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerProductRoutes(app);
  registerVendorRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (withUser) (req.session as Record<string, unknown>)['user_id'] = adminId;
  });
  return app;
}

const post = (app: ReturnType<typeof buildApp>, url: string, payload: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload: new URLSearchParams(payload).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

async function cleanup() {
  await db.deleteFrom('os_sku_vendors').where('sku', '=', SKU).execute();
  await db.deleteFrom('os_vendors').where('name', 'in', NAMES).execute();
  await db.deleteFrom('os_products').where('id', '=', PID as never).execute();
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
  await cleanup();
  const now = nowDb() as unknown as Date;
  await db.insertInto('os_products').values({ id: PID, sku: SKU, name: 'zz vendor product', status: 'Active', created_at: now, updated_at: now } as never).execute();
});

afterAll(cleanup);

describe('vendors', () => {
  it('requires login', async () => {
    const app = buildApp(false);
    expect((await app.inject({ method: 'GET', url: '/Vendors' })).statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/api/vendors' })).statusCode).toBe(302);
    await app.close();
  });

  it('creates, validates, renames, assigns, lists on /api/products, blocks delete while assigned', async () => {
    const app = buildApp(true);

    // create + validation
    expect((await post(app, '/api/vendors', { name: '  ' })).statusCode).toBe(422);
    const a = await post(app, '/api/vendors', { name: ' ZZ Vendor A ', notes: 'first' });
    expect(a.statusCode).toBe(201);
    const aId = a.json().id as number;
    expect(a.json()).toMatchObject({ name: 'ZZ Vendor A', notes: 'first', sku_count: 0 });
    expect((await post(app, '/api/vendors', { name: 'zz vendor a' })).statusCode).toBe(409); // case-insensitive duplicate
    const b = await post(app, '/api/vendors', { name: 'ZZ Vendor B' });
    const bId = b.json().id as number;

    // rename (+ duplicate guard)
    expect((await post(app, `/api/vendors/${aId}`, { name: 'ZZ Vendor B' })).statusCode).toBe(409);
    expect((await post(app, `/api/vendors/${aId}`, { name: 'ZZ Vendor A2', notes: '' })).json()).toMatchObject({ success: true, name: 'ZZ Vendor A2', notes: null });
    expect((await post(app, '/api/vendors/999999999', { name: 'x' })).statusCode).toBe(404);

    // list + page
    const list = (await app.inject({ method: 'GET', url: '/api/vendors' })).json() as Array<{ id: number; name: string; sku_count: number }>;
    expect(list.find((v) => v.id === aId)).toMatchObject({ name: 'ZZ Vendor A2', sku_count: 0 });
    expect((await app.inject({ method: 'GET', url: '/Vendors' })).statusCode).toBe(200); // Vue SPA shell

    // assign; reassigning moves it (one vendor per SKU)
    expect((await post(app, `/api/product/${PID}/vendor`, { vendor_id: String(aId) })).json()).toEqual({ success: true, vendor_id: aId, vendor_name: 'ZZ Vendor A2' });
    expect((await post(app, `/api/product/${PID}/vendor`, { vendor_id: String(bId) })).json()).toEqual({ success: true, vendor_id: bId, vendor_name: 'ZZ Vendor B' });
    expect(await db.selectFrom('os_sku_vendors').select('vendor_id').where('sku', '=', SKU).execute()).toHaveLength(1);
    expect((await post(app, `/api/product/${PID}/vendor`, { vendor_id: '999999999' })).statusCode).toBe(404);
    expect((await post(app, '/api/product/999999999/vendor', { vendor_id: String(aId) })).statusCode).toBe(404);

    // vendor shows up on the Products list API
    const products = (await app.inject({ method: 'GET', url: `/api/products?filter=${SKU}` })).json() as { products: Array<{ sku: string; vendor_id: number | null; vendor_name: string | null }> };
    expect(products.products.find((p) => p.sku === SKU)).toMatchObject({ vendor_id: bId, vendor_name: 'ZZ Vendor B' });

    // vendor filter on the list API: by vendor id, and 'none' (no vendor)
    const byVendor = (await app.inject({ method: 'GET', url: `/api/products?vendor_id=${bId}` })).json() as { total: number; products: Array<{ sku: string }> };
    expect(byVendor.products.map((p) => p.sku)).toEqual([SKU]);
    expect(byVendor.total).toBe(1);
    const otherVendor = (await app.inject({ method: 'GET', url: `/api/products?vendor_id=${aId}` })).json() as { total: number; products: unknown[] };
    expect(otherVendor).toEqual({ total: 0, products: [] });
    const unassigned = (await app.inject({ method: 'GET', url: '/api/products?vendor_id=none&filter=zz vendor product' })).json() as { products: unknown[] };
    expect(unassigned.products).toHaveLength(0);

    // single-product API (product modal) carries the vendor too
    const single = (await app.inject({ method: 'GET', url: `/api/product/${PID}` })).json() as { vendor_id: number | null; vendor_name: string | null };
    expect(single).toMatchObject({ vendor_id: bId, vendor_name: 'ZZ Vendor B' });

    // cannot delete an assigned vendor; can after clearing the assignment
    const blocked = await app.inject({ method: 'DELETE', url: `/api/vendors/${bId}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('assigned to 1 product');
    expect((await post(app, `/api/product/${PID}/vendor`, { vendor_id: '' })).json()).toEqual({ success: true, vendor_id: null, vendor_name: null });
    const nowUnassigned = (await app.inject({ method: 'GET', url: `/api/products?vendor_id=none&filter=${SKU}` })).json() as { products: Array<{ sku: string }> };
    expect(nowUnassigned.products.map((p) => p.sku)).toEqual([SKU]);
    expect((await app.inject({ method: 'DELETE', url: `/api/vendors/${bId}` })).json()).toEqual({ success: true });
    expect((await app.inject({ method: 'DELETE', url: `/api/vendors/${bId}` })).statusCode).toBe(404);
    await app.close();
  });
});
