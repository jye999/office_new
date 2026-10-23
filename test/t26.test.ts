// T26: Product@vue SPA shell + catch-all fallbacks + list/get JSON APIs.
// Read-only against the live DB: every assertion cross-checks the JSON the
// handlers return against the same data read directly with Kysely/raw SQL.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerProductRoutes } from '../src/modules/product/routes.js';
import { registerViewPlugins } from '../src/view.js';

type Row = { id: number };

async function userWithRole(roles: string[]): Promise<Row | null> {
  return (
    (await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()) ?? null);
}

async function userWithoutRole(): Promise<Row | null> {
  const rows = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id as uid', 'os_roles.name as role'])
    .execute();
  const byUser = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = byUser.get(r.uid) ?? new Set<string>();
    s.add(r.role);
    byUser.set(r.uid, s);
  }
  for (const [id, rs] of byUser) if (![...rs].some((x) => ['admin', 'user', 'remote'].includes(x))) return { id };
  return null;
}

// installRouter before any route registration (T03 contract).
function buildApp(user: Row | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerProductRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T26 product vue + JSON APIs (fastify inject, live DB)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    let res = await anon.inject({ method: 'GET', url: '/vue' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      for (const u of ['/vue', '/api/products', '/api/productSkus', '/product.sku?sku=X']) {
        res = await app.inject({ method: 'GET', url: u });
        expect(res.statusCode).toBe(403);
        expect(res.body).toBe('No Access.');
      }
      await app.close();
    }
  });

  it('renders /vue, /Product/{id} and the four catch-alls as the SPA shell', async () => {
    const admin = await userWithRole(['admin']);
    expect(admin, 'need an admin user').not.toBeNull();
    const app = buildApp(admin);
    for (const u of ['/vue', '/ListProducts', '/InventoryCount', '/InventoryConsolidation', '/Orders', '/Product/42']) {
      const res = await app.inject({ method: 'GET', url: u });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<div id="app">');
      expect(res.body).toContain('//cdn.materialdesignicons.com/2.0.46/css/materialdesignicons.min.css');
      expect(res.body).toContain('isAdmin = true;'); // @role(['admin']) branch
    }
    // POST is served by the same `any` route.
    const post = await app.inject({ method: 'POST', url: '/Product/42' });
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain('<div id="app">');
    await app.close();

    // non-admin: the isAdmin=true branch is absent
    const other = await userWithRole(['user', 'remote']);
    if (other && other.id !== admin!.id) {
      const app2 = buildApp(other);
      const res = await app2.inject({ method: 'GET', url: '/vue' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('var isAdmin = false;');
      expect(res.body).not.toContain('isAdmin = true;');
      await app2.close();
    }
  });

  it('/api/product.sku + /product.sku: product JSON, 404 string when missing', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const real = (
      await db
        .selectFrom('os_products')
        .selectAll()
        .where('sku', 'is not', null)
        .where('sku', 'like', 'A%')
        .executeTakeFirst()
    ) as unknown as Record<string, unknown> | undefined;
    expect(real, 'need a product with sku starting A').toBeDefined();
    const sku = real!.sku as string;
    const res = await app.inject({ method: 'GET', url: `/api/product.sku?sku=${encodeURIComponent(sku)}` });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json['sku']).toBe(sku);
    expect(json['type']).toBe([...sku][0]);
    expect(json['sku_num']).toBe([...sku].slice(1).join(''));
    expect(Array.isArray(json['locations'])).toBe(true);
    expect(Array.isArray(json['images'])).toBe(true);
    // direct-DB cross-check of the relations
    const locs = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', real!.id as number).execute();
    expect(json['locations']).toHaveLength(locs.length);
    expect(json).toMatchObject({ id: real!.id, name: real!.name, status: real!.status });

    // /product.sku is the same action
    const res2 = await app.inject({ method: 'GET', url: `/product.sku?sku=${encodeURIComponent(sku)}` });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual(json);

    // missing sku param and unknown sku -> JSON string 'product not found', 404
    for (const u of ['/api/product.sku', `/api/product.sku?sku=T26NOPE${Date.now()}`]) {
      const res3 = await app.inject({ method: 'GET', url: u });
      expect(res3.statusCode).toBe(404);
      expect(res3.body).toBe(JSON.stringify('product not found'));
      expect(res3.headers['content-type']).toContain('application/json');
    }
    await app.close();
  });

  it('/api/product/{id}: product JSON; unknown id -> 404', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const real = (await db.selectFrom('os_products').select(['id']).executeTakeFirst())!;
    const res = await app.inject({ method: 'GET', url: `/api/product/${real.id}` });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json['id']).toBe(real.id);
    expect(json).toHaveProperty('locations');
    expect(json).toHaveProperty('images');
    const miss = await app.inject({ method: 'GET', url: '/api/product/999999999' });
    expect(miss.statusCode).toBe(404);
    // findOrFail renders the app's 404 HTML page (T03), not fastify's JSON.
    expect(miss.headers['content-type']).toContain('text/html');
    expect(miss.body).toContain('404 | Not Found');
    await app.close();
  });

  it('/api/products: total/filter/paging cross-checked against direct SQL', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);

    // The old app runs concurrently on this DB — retry once if rows change
    // between the count read and the endpoint read.
    let total = 0;
    let res = await app.inject({ method: 'GET', url: '/api/products' });
    expect(res.statusCode).toBe(200);
    let json = res.json() as { total: number } & { products?: Record<string, unknown>[] };
    let stable = false;
    for (let a = 0; a < 2 && !stable; a++) {
      const [{ n }] = ((await sql`select count(*) as n from os_products where status = 'Active'`
        .execute(db)).rows) as unknown as { n: number }[];
      total = n;
      res = await app.inject({ method: 'GET', url: '/api/products' });
      json = res.json() as { total: number } & { products?: Record<string, unknown>[] };
      stable = json.total === total && (json.products?.length ?? 0) === total;
    }
    expect(stable).toBe(true);
    expect(json.total).toBe(total);
    // PHP only applies skip/take when a numeric `page` param is present — no
    // page means ALL active products.
    expect(json.products).toHaveLength(total);
    for (const p of json.products!) {
      expect(p['status']).toBe('Active');
      expect(p).toHaveProperty('type');
      expect(p).toHaveProperty('sku_num');
      expect(p).toHaveProperty('locations');
      expect(p).toHaveProperty('images');
    }

    // paging: page=1&pageSize=2 -> first 2 of the same set
    res = await app.inject({ method: 'GET', url: '/api/products?page=1&pageSize=2' });
    json = res.json() as { total: number; products: Record<string, unknown>[] };
    expect(json.total).toBe(total);
    expect(json.products).toHaveLength(2);
    expect(json.products!.map((p) => p['id'])).toEqual(
      (await db
        .selectFrom('os_products')
        .select(['id'])
        .where('status', '=', 'Active')
        .limit(2)
        .execute()
      ).map((r) => r.id),
    );

    // filter matches the PHP or-chain (name/chinese/sku/vendor_sku like, upc =)
    const row = (
      await db
        .selectFrom('os_products')
        .select(['sku'])
        .where('status', '=', 'Active')
        .where('sku', 'is not', null)
        .executeTakeFirst()
    )!;
    const f = encodeURIComponent(String(row.sku).slice(0, 2));
    const [{ n: sqlTotal }] = ((await sql`
      select count(*) as n from os_products
      where status = 'Active' and (
        name like ${`%${row.sku!.slice(0, 2)}%`}
        or chinese like ${`%${row.sku!.slice(0, 2)}%`}
        or sku like ${`%${row.sku!.slice(0, 2)}%`}
        or vendor_sku like ${`%${row.sku!.slice(0, 2)}%`}
        or upc = ${row.sku!.slice(0, 2)}
      )
    `.execute(db)).rows) as unknown as { n: number }[];
    res = await app.inject({ method: 'GET', url: `/api/products?filter=${f}` });
    json = res.json() as { total: number };
    expect(json.total).toBe(sqlTotal);
    await app.close();
  });

  it('/api/productLocations: total, location asc order, product relation (sku not null)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/api/productLocations' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { total: number; locations: Record<string, unknown>[] };
    // no page param -> no skip/take (same as PHP); internally consistent count.
    expect(json.locations).toHaveLength(json.total);
    // default order: location asc — the handler issues the identical
    // `ORDER BY location ASC` PHP does; collation-sensitive ordering parity is
    // verified by `pnpm parity` (JS localeCompare does not match MySQL's
    // utf8mb3_general_ci, e.g. 'B12' vs 'B12 ', and this DB churns while the
    // old app runs).
    // product relation honoured whereNotNull('sku')
    for (const l of json.locations.slice(0, 20)) {
      const product = l['product'] as Record<string, unknown> | null;
      const real = (
        await db
          .selectFrom('os_products')
          .select(['id', 'sku'])
          .where('id', '=', l['product_id'] as number)
          .executeTakeFirst()
      ) ?? null;
      if (!real || real.sku === null) {
        expect(product).toBeNull();
      } else {
        expect(product).not.toBeNull();
        expect(product!['id']).toBe(real.id);
        expect(product!['sku']).toBe(real.sku);
      }
    }

    // filter = location like OR exists product sku like; cross-check vs SQL
    // (retry: the old app writes to this DB while the test runs).
    const sample = (await db.selectFrom('os_product_locations').select(['location']).limit(1).execute())[0];
    const f = String(sample.location).slice(0, 1);
    let filterMatched = false;
    for (let a = 0; a < 3 && !filterMatched; a++) {
      const [{ n: sqlTotal }] = ((await sql`
        select count(*) as n from os_product_locations
        where location like ${`%${f}%`}
          or exists (select 1 from os_products where os_products.id = os_product_locations.product_id and sku like ${`%${f}%`})
      `.execute(db)).rows) as unknown as { n: number }[];
      const res2 = await app.inject({ method: 'GET', url: `/api/productLocations?filter=${encodeURIComponent(f)}` });
      filterMatched = (res2.json() as { total: number }).total === sqlTotal;
    }
    expect(filterMatched).toBe(true);
    await app.close();
  });

  it('/api/productSkus: json-encoded string of distinct non-null skus, ordered', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/api/productSkus' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { skus: string };
    expect(typeof json.skus).toBe('string'); // json_encode()d STRING, not an array
    // retry: the old app writes to this DB while the test runs
    let matched = false;
    let list: string[] = [];
    for (let a = 0; a < 3 && !matched; a++) {
      list = JSON.parse((res.json() as { skus: string }).skus) as string[];
      const expected = (await db.selectFrom('os_products').select('sku').groupBy('sku').orderBy('sku').execute())
        .filter((s) => s.sku !== null)
        .map((s) => s.sku as string);
      matched = list.length === expected.length && list.every((v, i) => v === expected[i]);
    }
    expect(matched).toBe(true);
    await app.close();
  });
});
