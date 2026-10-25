// T28: Product resource pages, datatables, ship weight, product map, bulk
// production. GET pages via inject against the live DB (read-only); the
// write routes use temp t28* rows that are created and cleaned up in-test.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { config as appConfig } from '../src/config.js';
import { installRouter } from '../src/router.js';

// View url()/asset() are APP_URL-based; lredirect Location uses the request
// host (fastify inject defaults to localhost:80).
const BASE = appConfig.APP_URL.replace(/\/+$/, '');
import { registerProductRoutes } from '../src/modules/product/routes.js';
import { registerViewPlugins } from '../src/view.js';

type Row = { id: number };

const PREFIX = `t28${Date.now() % 100000}`;

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

let admin: Row | null;
let noRole: Row | null;

function buildApp(user: Row | null) {
  // Same bracket-notation query parser as server.ts (T25b) for DataTables GETs.
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(multipart, { attachFieldsToBody: false });
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerProductRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

afterAll(async () => {
  // SAFETY: PK-only cleanup of any leaked temp rows (tests also clean up).
  await db.deleteFrom('os_product_map').where('sku', 'like', `${PREFIX}%`).execute();
  await db.deleteFrom('os_product_ship_weight').where('sku', 'like', `${PREFIX}%`).execute();
  await db.deleteFrom('os_products').where('name', 'like', `${PREFIX}%`).execute();
  await db.destroy();
});

beforeAll(async () => {
  admin = await userWithRole(['admin']);
  noRole = await userWithoutRole();
});

describe('T28 guards', () => {
  it('anon 302 -> /login and non-allowed role 403 No Access. on the route classes', async () => {
    const anon = buildApp(null);
    const paths = ['/products', '/products.data', '/products.bulk', '/products.viewbulk', '/product', '/product/create', '/product/2706/edit', '/product/2706/deleteMsg', '/updateProductMap', '/GetProductShipWeight'];
    for (const p of paths) {
      const res = await anon.inject({ method: 'GET', url: p });
      expect(res.statusCode, p).toBe(302);
      expect(res.headers['location'], p).toContain('/login');
    }
    const four = noRole ? buildApp(noRole) : null;
    if (four) {
      for (const p of paths) {
        const res = await four.inject({ method: 'GET', url: p });
        expect(res.statusCode, p).toBe(403);
        expect(res.body, p).toBe('No Access.');
      }
    }
    await anon.close();
    await four?.close();
  });
});

describe('T28 product pages', () => {
  it('/products renders the standalone Vue shell', async () => {
    const app = buildApp(admin);
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('{{ message }}');
    expect(res.body).toContain('js/app.js');
    await app.close();
  });

  it('/product (resource index) renders the same shell', async () => {
    const app = buildApp(admin);
    const res = await app.inject({ method: 'GET', url: '/product' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('{{ message }}');
    await app.close();
  });

  it('/product/create renders the create form', async () => {
    const app = buildApp(admin);
    const res = await app.inject({ method: 'GET', url: '/product/create' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="addProductForm"');
    expect(res.body).toContain('method="POST"');
    expect(res.body).toContain('media="all" type="text/css" rel="stylesheet" href="');
    expect(res.body).toContain('/packages/dropzone/dropzone.js');
    await app.close();
  });

  it('/product/:id/edit renders the product row; missing id 404s', async () => {
    const app = buildApp(admin);
    const res = await app.inject({ method: 'GET', url: '/product/2706/edit' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="A004GD"');
    // blade: url('/storage/product_images_icon/') . '/' . main_image -> slash kept for an empty image
    expect(res.body).toMatch(/id="main_image_show" src="[^"]*\/storage\/product_images_icon\/[^"]*"/);
    // blade used single-quoted attributes
    expect(res.body).toContain(`action = '${BASE}/product/2706/update'`);
    const missing = await app.inject({ method: 'GET', url: '/product/999999/edit' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('T28 show / deleteMsg', () => {
  it('show: XHR returns the absolute URL, HTML 500s (old-app $item fatal), missing 404s', async () => {
    const app = buildApp(admin);
    const xhr = await app.inject({ method: 'GET', url: '/product/2706', headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(xhr.statusCode).toBe(200);
    expect(xhr.body).toBe(`${BASE}/product/2706`);
    const html = await app.inject({ method: 'GET', url: '/product/2706' });
    expect(html.statusCode).toBe(500);
    const missing = await app.inject({ method: 'GET', url: '/product/999999' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('deleteMsg: XHR returns the Ajaxis modal, non-XHR returns empty 200', async () => {
    const app = buildApp(admin);
    const xhr = await app.inject({ method: 'GET', url: '/product/2706/deleteMsg', headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(xhr.statusCode).toBe(200);
    expect(xhr.body).toContain('<h4 class="modal-title" id="myModalLabel">Warning!!</h4>');
    expect(xhr.body).toContain('data-link = "/product/2706/delete">Agree');
    const plain = await app.inject({ method: 'GET', url: '/product/2706/deleteMsg' });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toBe('');
    await app.close();
  });
});

describe('T28 anyData', () => {
  it('serves the yajra protocol with Eloquent appends (type, sku_num) last', async () => {
    const app = buildApp(admin);
    const res = await app.inject({ method: 'GET', url: '/products.data' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { draw: number; recordsTotal: number; recordsFiltered: number; data: Record<string, unknown>[] };
    expect(json.draw).toBe(0);
    // SAFETY: count(*) projection.
    const [{ n }] = (await db.selectFrom('os_products').select(sql`count(*)`.as('n')).execute()) as { n: number }[];
    expect(json.recordsTotal).toBe(n);
    expect(json.recordsFiltered).toBe(n);
    expect(json.data.length).toBe(n);
    const row = json.data[0];
    const keys = Object.keys(row);
    expect(keys.slice(-2)).toEqual(['type', 'sku_num']);
    expect(row['type']).toBe([...String(row['sku'] ?? '')][0] ?? '');
    expect(row['sku_num']).toBe([...String(row['sku'] ?? '')].slice(1).join(''));
    // pagination: length 1, start 0
    const page = await app.inject({ method: 'GET', url: '/products.data?draw=2&start=0&length=1' });
    const pjson = page.json() as typeof json;
    expect(pjson.draw).toBe(2);
    expect(pjson.data.length).toBe(1);
    expect(pjson.recordsTotal).toBe(n);
    // global search narrows the filtered count; v6 only searches columns the
    // client declares (columns[i][searchable]=true), so the payload mirrors a
    // real DataTables GET
    const searched = await app.inject({
      method: 'GET',
      url: '/products.data?search[value]=A004GD&columns[0][data]=sku&columns[0][searchable]=true',
    });
    const sjson = searched.json() as typeof json;
    expect(sjson.recordsFiltered).toBe(1);
    expect(sjson.data[0]['sku']).toBe('A004GD');
    await app.close();
  });
});

describe('T28 product map + ship weight', () => {
  it('UpdateProductMap upserts (store, externalId); externalAsin fallback', async () => {
    const app = buildApp(admin);
    const sku = `${PREFIX}MAP`;
    const res = await app.inject({ method: 'POST', url: '/updateProductMap', payload: { store: 't28store', externalSku: `${PREFIX}EXT`, sku, qty: '3' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('"OK"');
    // SAFETY: os_product_map rows -> Record.
    const rows = (await db.selectFrom('os_product_map').selectAll().where('sku', 'like', `${PREFIX}%`).execute()) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]['store']).toBe('t28store');
    expect(rows[0]['externalId']).toBe(`${PREFIX}EXT`);
    expect(String(rows[0]['qty'])).toBe('3');
    // second hit updates in place (no new row)
    const res2 = await app.inject({ method: 'POST', url: '/updateProductMap', payload: { store: 't28store', externalSku: `${PREFIX}EXT`, sku, qty: '7' } });
    expect(res2.body).toBe('"OK"');
    const rows2 = (await db.selectFrom('os_product_map').selectAll().where('sku', 'like', `${PREFIX}MAP%`).execute()) as Record<string, unknown>[];
    expect(rows2.length).toBe(1);
    expect(String(rows2[0]['qty'])).toBe('7');
    // empty externalSku falls back to externalAsin -> new row
    const res3 = await app.inject({ method: 'POST', url: '/updateProductMap', payload: { store: 't28store', externalSku: '', externalAsin: 'B0T28', sku, qty: '1' } });
    expect(res3.body).toBe('"OK"');
    const rows3 = (await db.selectFrom('os_product_map').select('externalId').where('sku', 'like', `${PREFIX}MAP%`).execute()) as { externalId: string }[];
    expect(rows3.map((r) => r.externalId).sort()).toEqual([`B0T28`, `${PREFIX}EXT`].sort());
    await db.deleteFrom('os_product_map').where('sku', 'like', `${PREFIX}%`).execute();
    await app.close();
  });

  it('GetProductShipWeight / SaveProductShipWeight round-trip', async () => {
    const app = buildApp(admin);
    const sku = `${PREFIX}W`;
    const missing = await app.inject({ method: 'POST', url: '/GetProductShipWeight', payload: { sku, qty: '2' } });
    expect(missing.body).toBe('"not found"');
    const save = await app.inject({ method: 'POST', url: '/SaveProductShipWeight', payload: { sku, qty: '2', width: '1', height: '2', length: '3', weight_lb: '4', weight_oz: '5', package_type: 'P', declare_value: '10', insured_value: '11', need_signature: '0' } });
    expect(save.body).toBe('"OK"');
    const get = await app.inject({ method: 'POST', url: '/GetProductShipWeight', payload: { sku, qty: '2' } });
    expect(get.statusCode).toBe(200);
    const row = get.json() as Record<string, unknown>;
    expect(row['width']).toBe('1');
    expect(row['weight_oz']).toBe('5');
    expect(row['need_signature']).toBe('0');
    expect(row['sku']).toBe(sku);
    // update branch
    const save2 = await app.inject({ method: 'POST', url: '/SaveProductShipWeight', payload: { sku, qty: '2', width: '9' } });
    expect(save2.body).toBe('"OK"');
    const rows = (await db.selectFrom('os_product_ship_weight').selectAll().where('sku', 'like', `${PREFIX}%`).execute()) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]['width']).toBe('9');
    // PHP assigns ALL eight fields unconditionally: missing height -> NULL
    expect(rows[0]['height']).toBeNull();
    await db.deleteFrom('os_product_ship_weight').where('sku', 'like', `${PREFIX}%`).execute();
    await app.close();
  });
});

describe('T28 bulk production (S3 bucket missing -> 500, as the old app)', () => {
  it('/products.bulk and /products.viewbulk 500', async () => {
    const app = buildApp(admin);
    for (const p of ['/products.bulk', '/products.viewbulk']) {
      const res = await app.inject({ method: 'GET', url: p });
      expect(res.statusCode, p).toBe(500);
    }
    await app.close();
  });

  it('deleteBulkProduction and uploadBulkProduction 500 (bucket missing; no DB writes)', async () => {
    const app = buildApp(admin);
    const del = await app.inject({ method: 'DELETE', url: '/products.deleteBulk', payload: { id: 'nope.jpg' } });
    expect(del.statusCode).toBe(500);
    const boundary = '----t28boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bulkFile"; filename="a b.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`, 'binary'),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/products.uploadBulk',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(500);
    await app.close();
  });
});

describe('T28 resource write lifecycle (temp rows, cleaned up)', () => {
  it('store -> update (validation + unconditional assigns) -> destroy', async () => {
    const app = buildApp(admin);
    const name = `${PREFIX}PROD`;
    const sku = `${PREFIX}SKU`;
    const created = await app.inject({ method: 'POST', url: '/product', payload: { name, sku, price: '1.5' } });
    expect(created.statusCode).toBe(200);
    const product = created.json() as { id: number; name: string; sku: string; price: string };
    expect(product.name).toBe(name);

    // update without name -> redirect back with errors (non-JSON)
    const bad = await app.inject({ method: 'POST', url: `/product/${product.id}/update`, payload: { upc: '123' } });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers['location']).toContain('/');

    // valid update: name+upc set, the other listed fields nulled
    const ok = await app.inject({ method: 'POST', url: `/product/${product.id}/update`, payload: { name, upc: '123456789012' } });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers['location']).toBe('http://localhost:80/product');
    // SAFETY: os_products row -> Record.
    const row = (await db.selectFrom('os_products').selectAll().where('id', '=', product.id).executeTakeFirst()) as Record<string, unknown>;
    expect(row['name']).toBe(name);
    expect(row['upc']).toBe('123456789012');
    expect(row['sku']).toBeNull();
    expect(row['price']).toBeNull();
    expect(row['bullet_point_1']).toBeNull();

    // JSON client gets the 422 body
    const badJson = await app.inject({
      method: 'POST',
      url: `/product/${product.id}/update`,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      payload: JSON.stringify({ upc: '123' }),
    });
    expect(badJson.statusCode).toBe(422);
    expect(badJson.json()['message']).toBe('The name field is required.');

    // destroy: plain URL text body, row gone
    const destroyed = await app.inject({ method: 'DELETE', url: `/product/${product.id}` });
    expect(destroyed.statusCode).toBe(200);
    expect(destroyed.body).toBe(`${BASE}/product`);
    const gone = await db.selectFrom('os_products').select('id').where('id', '=', product.id).executeTakeFirst();
    expect(gone).toBeUndefined();

    // destroy of a missing product 404s
    const missing = await app.inject({ method: 'DELETE', url: '/product/999999' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

