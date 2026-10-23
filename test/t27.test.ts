// T27: Product store/update API, images, locations, mass update/delete,
// thumbnails. Mutating routes, exercised with fastify inject against the live
// DB using temp t27* rows that are created and cleaned up within each test.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { disk } from '../src/storage.js';
import { installRouter } from '../src/router.js';
import { registerProductRoutes } from '../src/modules/product/routes.js';
import { registerViewPlugins } from '../src/view.js';

type Row = { id: number };

const PREFIX = `t27${Date.now() % 100000}`;

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

function buildApp(user: Row | null) {
  const app = Fastify();
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

// A tiny valid 1x1 PNG for the multipart upload tests (same one T21 uses).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Binary-safe multipart builder: text field/file headers + raw file bytes.
function multipartBody(boundary: string, fields: Record<string, string>, files: { buffer: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'binary'));
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, 'binary'), f.buffer, Buffer.from('\r\n', 'binary'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const full = disk('product_image_full');
const icon = disk('product_image_icon');

// Safety net: remove any leftover t27 rows/files if a test aborts mid-way.
afterAll(async () => {
  const products = await db.selectFrom('os_products').select(['id', 'sku']).where('sku', 'like', `${PREFIX}%`).execute();
  for (const p of products) {
    await db.deleteFrom('os_product_locations').where('product_id', '=', p.id).execute();
    await db.deleteFrom('os_products').where('id', '=', p.id).execute();
  }
  const imgs = await db.selectFrom('os_product_images').select(['id', 'filename']).where('product_id', 'like', `${PREFIX}%`).execute();
  for (const im of imgs) {
    await full.delete(im.filename);
    await icon.delete(im.filename);
    await db.deleteFrom('os_product_images').where('id', '=', im.id).execute();
  }
  await db.destroy();
});

describe('T27 product store/update + images + locations (fastify inject, live DB)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    let res = await anon.inject({ method: 'POST', url: '/api/product', payload: JSON.stringify({ name: 'x', sku: 'y' }), headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      for (const [method, url] of [
        ['POST', '/api/product'],
        ['DELETE', '/api/product/1'],
        ['POST', '/api/products.update'],
        ['GET', '/api/createAllThumbnail'],
      ] as const) {
        res = await app.inject({ method, url });
        expect(res.statusCode).toBe(403);
        expect(res.body).toBe('No Access.');
      }
      await app.close();
    }
  });

  it('store: create (validation 422s), locations insert, qty recompute', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user, 'need an admin/user/remote user').not.toBeNull();
    const app = buildApp(user);
    const json = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json' } });

    // Validation: missing name + duplicate sku/name -> 422 JSON
    let res = await json('/api/product', { sku: 'x' });
    expect(res.statusCode).toBe(422);
    let body = res.json() as Record<string, unknown>;
    expect(body['message']).toBe('The name field is required.');
    expect(body['errors']).toEqual({ name: ['The name field is required.'] });

    const name = `${PREFIX} name`;
    res = await json('/api/product', { name, sku: name }); // name already exists (above attempt? no — above had no name, so sku=name unique)
    // The first 422 wrote nothing, so this create should succeed (name unique).
    expect(res.statusCode).toBe(200);
    let prod = res.json() as Record<string, unknown>;
    expect(prod['id']).toBeTruthy();
    expect(prod['type']).toBe(PREFIX[0]);
    expect(prod['sku_num']).toBe(name.slice(1));
    expect(prod['qty']).toBe(0); // no locations

    // Duplicate name + max:20 on sku
    res = await json('/api/product', { name, sku: `${PREFIX}Z`.padEnd(21, 'a') });
    expect(res.statusCode).toBe(422);
    body = res.json() as Record<string, unknown>;
    expect(body['message']).toBe('The name has already been taken.');
    expect(body['errors']).toEqual({
      name: ['The name has already been taken.'],
      sku: [`The sku may not be greater than 20 characters.`],
    });

    // Create with locations (fresh + one PO location that must be ignored in qty)
    const sku2 = `${PREFIX}S2`;
    res = await json('/api/product', {
      name: `${PREFIX} name 2`,
      sku: sku2,
      price: '9.99',
      wholesale_category_list: ['c1', 'c2'],
      in_stock: false,
      locations: [
        { location: 'T27L1', qty: 3 },
        { location: 'T27POX', qty: 99 },
      ],
    });
    expect(res.statusCode).toBe(200);
    prod = res.json() as Record<string, unknown>;
    const id2 = prod['id'] as number;
    expect(prod['qty']).toBe(3); // PO location excluded
    expect(prod['wholesale_category_list']).toBe('c1,c2');
    expect(prod['in_stock']).toBe(0);
    const locs = (await db.selectFrom('os_product_locations').select(['location', 'qty']).where('product_id', '=', id2).orderBy('location').execute()) as unknown as { location: string; qty: number }[];
    expect(locs).toEqual([
      { location: 'T27L1', qty: 3 },
      { location: 'T27POX', qty: 99 },
    ]);
    const row2 = (await db.selectFrom('os_products').select(['name', 'created_at', 'updated_at']).where('id', '=', id2).executeTakeFirst())!;
    expect(row2.created_at).not.toBeNull();

    // Update: existing location by id + new location, in_stock true
    const loc1 = locs[0];
    res = await json(`/api/product/${id2}`, {
      name: `${PREFIX} name 2b`,
      sku: sku2,
      in_stock: true,
      locations: [
        { id: (await db.selectFrom('os_product_locations').select(['id']).where('product_id', '=', id2).where('location', '=', 'T27L1').executeTakeFirst())!.id, location: 'T27L1B', qty: 5, countdate: '2020-01-02 03:04:05' },
        { location: 'T27L2', qty: 2 },
      ],
    });
    expect(res.statusCode).toBe(200);
    prod = res.json() as Record<string, unknown>;
    expect(prod['qty']).toBe(7);
    const locs2 = (await db.selectFrom('os_product_locations').select(['location', 'qty', 'countdate']).where('product_id', '=', id2).orderBy('location').execute()) as unknown as { location: string; qty: number; countdate: string | null }[];
    expect(locs2).toHaveLength(3); // T27L1B (updated in place, same id), T27L2, T27POX
    expect(locs2.find((l) => l.location === 'T27L1B')).toEqual({ location: 'T27L1B', qty: 5, countdate: '2020-01-02 03:04:05' });
    expect(loc1).toBeDefined(); // keep the handle for cleanup bookkeeping

    // Out-of-stock branch: in_stock false -> all locations qty 0
    res = await json(`/api/product/${id2}`, { name: `${PREFIX} name 2b`, sku: sku2, in_stock: false });
    expect(res.statusCode).toBe(200);
    prod = res.json() as Record<string, unknown>;
    expect(prod['qty']).toBe(0);
    const q = await db.selectFrom('os_product_locations').select(['qty']).where('product_id', '=', id2).execute();
    expect(q.every((r) => r.qty === 0)).toBe(true);

    // Unknown id -> 404 HTML page (findOrFail)
    res = await json('/api/product/999999999', { name: 'x', sku: 'y' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('404 | Not Found');

    // POST /api/product (the api.php copy) also reaches store
    res = await json('/api/product', { name: `${PREFIX} name 3`, sku: `${PREFIX}S3` });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('images: uploadMultipleImage writes both disks + rows; deleteImage orphans the icon; deleteProduct', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const json = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await json('/api/product', { name: `${PREFIX} img`, sku: `${PREFIX}IM` });
    expect(res.statusCode).toBe(200);
    const id = (res.json() as Record<string, unknown>)['id'] as number;

    // Multipart upload of two files (field name `files`)
    const boundary = `t27boundary${Date.now()}`;
    let up = await app.inject({
      method: 'POST',
      url: `/api/product/${id}/images`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, { product_id: String(id) }, [{ buffer: PNG }, { buffer: PNG }]),
    });
    expect(up.statusCode).toBe(200);
    const names = up.json() as string[];
    expect(names).toHaveLength(2);
    for (let i = 0; i < 2; i++) expect(names[i]).toMatch(new RegExp(`^${id}_\\d{10}_${i}\\.png$`));
    for (const n of names) {
      expect(await full.exists(n)).toBe(true);
      expect(await icon.exists(n)).toBe(true);
    }
    const rows = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(id)).orderBy('id').execute();
    expect(rows.map((r) => r.filename)).toEqual(names);
    expect(rows.map((r) => r.original_name)).toEqual(['a.png', 'a.png']);

    // deleteImage removes the FULL file only (icon orphaned — kept quirk)
    let del = await app.inject({ method: 'DELETE', url: `/api/product/${id}/images/${rows[0].id}` });
    expect(del.statusCode).toBe(200);
    expect(del.body).toBe(JSON.stringify('ok'));
    expect(await full.exists(names[0])).toBe(false);
    expect(await icon.exists(names[0])).toBe(true); // orphaned
    expect((await db.selectFrom('os_product_images').select(['id']).where('id', '=', rows[0].id).executeTakeFirst())).toBeUndefined();

    // no files -> []
    up = await app.inject({
      method: 'POST',
      url: `/api/product/${id}/images`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, {}, []),
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual([]);

    // deleteProduct removes the product + its locations; 'ok'
    del = await app.inject({ method: 'DELETE', url: `/api/product/${id}` });
    expect(del.statusCode).toBe(200);
    expect(del.body).toBe(JSON.stringify('ok'));
    expect(await db.selectFrom('os_products').select(['id']).where('id', '=', id).executeTakeFirst()).toBeUndefined();
    // clean up the orphaned icon + remaining image row/files
    for (const r of rows) {
      await icon.delete(r.filename);
      await full.delete(r.filename);
      await db.deleteFrom('os_product_images').where('id', '=', r.id).execute();
    }
    await app.close();
  });

  it('locations: updateLocations, updateDefaultLocation, deleteLocation, updateLocationByLocId', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const json = (method: string, url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        payload: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      });

    const created = await json('POST', '/api/product', { name: `${PREFIX} loc`, sku: `${PREFIX}LC`, locations: [{ location: 'T27LA', qty: 1 }] });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as Record<string, unknown>)['id'] as number;
    const locA = (await db.selectFrom('os_product_locations').select(['id']).where('product_id', '=', id).executeTakeFirst())!;

    // updateLocations: update by id + create via the body's product_id
    let res = await json('POST', `/api/product/${id}/locations`, [
      { id: locA.id, product_id: id, location: 'T27LAB', qty: 4, packing: 1, carton: 2, countdate: '2021-01-01 00:00:00' },
      { product_id: id, location: 'T27LB', qty: 6, packing: 3, carton: 4 },
    ]);
    expect(res.statusCode).toBe(200);
    let out = res.json() as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    const got = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', id).orderBy('location').execute();
    // packing/carton are INT columns (non-numeric values 500 in both apps).
    expect(got.map((r) => [r.location, r.qty, r.packing, r.carton])).toEqual([
      ['T27LAB', 4, 1, 2],
      ['T27LB', 6, 3, 4],
    ]);

    // updateDefaultLocation: trims + uppercases; 422/404 branches
    res = await json('POST', `/api/product/${id}/default-location`, { location: ' t27lab ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, default_location: 'T27LAB' });
    res = await json('POST', `/api/product/${id}/default-location`, { location: '' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ success: false, message: 'location is required' });
    res = await json('POST', `/api/product/999999999/default-location`, { location: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, message: 'product not found' });
    res = await json('POST', `/api/product/${id}/default-location`, { location: 'T27NOPE' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, message: 'location not found' });

    // updateLocationByLocId: update branch uppercases location; insert does not
    const sku = `${PREFIX}LC`;
    res = await json('POST', '/api/location', { id: locA.id, sku, location: 't27lc', qty: 7, packing: 1, carton: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBe(locA.id);
    const updated = await db.selectFrom('os_product_locations').selectAll().where('id', '=', locA.id).executeTakeFirst();
    expect([updated!.location, updated!.qty, updated!.packing, updated!.carton]).toEqual(['T27LC', 7, 1, 2]);

    res = await json('POST', '/api/location', { id: null, sku, location: 't27lower', qty: 1, packing: 5, carton: 6 });
    expect(res.statusCode).toBe(200);
    const newId = res.json() as number;
    expect(typeof newId).toBe('number');
    const inserted = await db.selectFrom('os_product_locations').select(['location', 'product_id']).where('id', '=', newId).executeTakeFirst();
    expect(inserted).toEqual({ location: 't27lower', product_id: id }); // NOT uppercased

    // sku not found -> 500 JSON string
    res = await json('POST', '/api/location', { id: null, sku: `${PREFIX}NOPE` });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(JSON.stringify('sku not found'));

    // deleteLocation removes the row + replies ok; unknown id also 'ok'
    res = await json('DELETE', `/api/product/${id}/locations/${locA.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JSON.stringify('ok'));
    expect(await db.selectFrom('os_product_locations').select(['id']).where('id', '=', locA.id).executeTakeFirst()).toBeUndefined();
    out = res.json() as Record<string, unknown>[];
    void out;

    // cleanup
    await db.deleteFrom('os_product_locations').where('product_id', '=', id).execute();
    await db.deleteFrom('os_products').where('id', '=', id).execute();
    await app.close();
  });

  it('massUpdate/massDelete: failed lists + per-field updates', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const json = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    const a = await json('/api/product', { name: `${PREFIX} mu a`, sku: `${PREFIX}MUA` });
    const b = await json('/api/product', { name: `${PREFIX} mu b`, sku: `${PREFIX}MUB` });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const idA = (a.json() as Record<string, unknown>)['id'] as number;
    const idB = (b.json() as Record<string, unknown>)['id'] as number;

    let res = await json('/api/products.update', {
      products: [
        { id: idA, price: '12.34', weight: 2.5, wholesale_category_list: ['w1', 'w2'], description: 'desc' },
        { id: 999999999, price: 1 }, // missing product -> failed (catch findOrFail)
        { id: idB, price: 5, cost: 'not-a-number' }, // non-numeric -> failed
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([999999999, idB]);
    const rowA = (await db.selectFrom('os_products').select(['price', 'weight', 'wholesale_category_list', 'description']).where('id', '=', idA).executeTakeFirst())!;
    expect(rowA.price).toBe('12.34');
    expect(rowA.weight).toBe(2.5);
    expect(rowA.wholesale_category_list).toBe('w1,w2');
    expect(rowA.description).toBe('desc');
    const rowB = (await db.selectFrom('os_products').select(['price', 'cost']).where('id', '=', idB).executeTakeFirst())!;
    expect(rowB.price).toBe('5.00'); // DECIMAL comes back as a string (parity rule)
    expect(rowB.cost).toBeNull();

    // massDelete: deletes rows + their locations, lists the missing ids
    res = await json('/api/products.delete', { ids: [idA, 999999999] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([999999999]);
    expect(await db.selectFrom('os_products').select(['id']).where('id', '=', idA).executeTakeFirst()).toBeUndefined();

    // cleanup
    await db.deleteFrom('os_products').where('id', '=', idB).execute();
    await app.close();
  });

  it('createAllThumbnail: regenerates icon files from full-size, 200 empty body', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    expect(user).not.toBeNull();
    const app = buildApp(user);
    const filename = `${PREFIX}_thumb_0.png`;
    await full.put(filename, PNG);
    const ins = await db
      .insertInto('os_product_images')
      .values({ product_id: PREFIX, original_name: 'a.png', filename, created_at: new Date(), updated_at: new Date() } as never)
      .executeTakeFirst();
    const imageId = Number(ins.insertId);
    expect(await icon.exists(filename)).toBe(false);

    const res = await app.inject({ method: 'GET', url: '/api/createAllThumbnail' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(0); // PHP action returns null -> empty body

    expect(await icon.exists(filename)).toBe(true);
    const meta = await sharp(await icon.get(filename)).metadata();
    // 1x1 source, widen(100) with upsize() -> never enlarged -> stays 1x1.
    expect(meta.width).toBe(1);
    expect(meta.format).toBe('png');

    await icon.delete(filename);
    await full.delete(filename);
    await db.deleteFrom('os_product_images').where('id', '=', imageId).execute();
    await app.close();
  });
});
