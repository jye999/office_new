// T30: SupplierProduct API (+ /{Supplier?} fallback), ProductImage uploader,
// Faire image import. Fastify inject against the live DB with temp t30* rows
// that are created and cleaned up within each test.

import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.PRODUCT_IMAGE_IMPORT_TOKEN = 't30-token';
});

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { setFaireDownloadForTests, jobsFromRows, importFaireImages } from '../src/lib/faireImageImporter.js';
import { disk } from '../src/storage.js';
import { installRouter } from '../src/router.js';
import { registerFaireImportRoutes } from '../src/modules/faireimport/routes.js';
import { registerProductImageRoutes } from '../src/modules/productimage/routes.js';
import { registerSupplierRoutes } from '../src/modules/supplier/routes.js';
import { registerViewPlugins } from '../src/view.js';

type Row = { id: number; username?: string };

const PREFIX = `t30${Date.now() % 100000}`;

async function userWithRole(roles: string[]): Promise<Row> {
  const u = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id', 'os_users.username'])
    .where('os_roles.name', 'in', roles)
    .executeTakeFirstOrThrow();
  return u;
}

function buildApp(user: Row | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(multipart, { attachFieldsToBody: false });
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerSupplierRoutes(app);
  registerProductImageRoutes(app);
  registerFaireImportRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function multipartBody(boundary: string, fields: Record<string, string>, files: { name: string; filename: string; buffer: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'binary'));
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: image/png\r\n\r\n`, 'binary'),
      f.buffer,
      Buffer.from('\r\n', 'binary'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const JSON_HDR = { 'content-type': 'application/json', accept: 'application/json' };
const supFull = disk('supplier_product_image_full');
const supIcon = disk('supplier_product_image_icon');
const prodFull = disk('product_image_full');
const prodIcon = disk('product_image_icon');

// Safety net: remove any leftover t30 rows/files if a test aborts mid-way.
afterAll(async () => {
  setFaireDownloadForTests(null);
  const sps = await db.selectFrom('os_supplier_products').select(['id']).where('supplier', 'like', `${PREFIX}%`).execute();
  for (const p of sps) {
    await db.deleteFrom('os_supplier_product_messages').where('supplier_product_id', '=', String(p.id)).execute();
    const imgs = await db.selectFrom('os_supplier_product_images').select(['id', 'filename']).where('supplier_product_id', '=', String(p.id)).execute();
    for (const im of imgs) {
      await supFull.delete(im.filename);
      await supIcon.delete(im.filename);
      await db.deleteFrom('os_supplier_product_images').where('id', '=', im.id).execute();
    }
    await db.deleteFrom('os_supplier_products').where('id', '=', p.id).execute();
  }
  const imgs = await db.selectFrom('os_product_images').select(['id', 'filename']).where('product_id', 'like', `${PREFIX}%`).execute();
  for (const im of imgs) {
    await prodFull.delete(im.filename);
    await prodIcon.delete(im.filename);
    await db.deleteFrom('os_product_images').where('id', '=', im.id).execute();
  }
  await db.deleteFrom('os_faire_products').where('id', 'like', `${PREFIX}%`).execute();
  await db.destroy();
});

describe('T30 SupplierProduct', () => {
  it('guards: anon -> 302 /login; remote-only user -> 403 No Access. (routes + /Supplier fallback)', async () => {
    const anon = buildApp(null);
    let res = await anon.inject({ method: 'GET', url: '/api/supplierproducts' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/login$/);
    res = await anon.inject({ method: 'GET', url: '/Supplier' });
    expect(res.statusCode).toBe(302);
    await anon.close();

    // temp user whose only role is `remote` (allowed for images, denied for supplier)
    const now = '2020-01-01 00:00:00';
    const ins = await db.insertInto('os_users').values({ username: `${PREFIX}r`, email: `${PREFIX}r@x.test`, password: 'x', confirmation_code: '', created_at: now } as never).executeTakeFirstOrThrow();
    const uid = Number(ins.insertId);
    await db.insertInto('os_user_has_roles').values({ role_id: 5, user_id: uid } as never).execute();
    try {
      const app = buildApp({ id: uid });
      for (const [method, url] of [['GET', '/api/supplierproducts'], ['POST', '/api/supplierproducts'], ['GET', '/Supplier'], ['GET', '/SupplierProduct'], ['DELETE', '/api/supplierproduct/1']] as const) {
        res = await app.inject({ method, url });
        expect(res.statusCode, url).toBe(403);
        expect(res.body).toBe('No Access.');
      }
      res = await app.inject({ method: 'GET', url: '/productImageOnServer' });
      expect(res.statusCode).toBe(200);
      await app.close();
    } finally {
      await db.deleteFrom('os_user_has_roles').where('user_id', '=', uid).execute();
      await db.deleteFrom('os_users').where('id', '=', uid).execute();
    }
  });

  it('SPA shell on /Supplier, /Supplier/Supplier (fallback) and /SupplierProduct/5', async () => {
    const app = buildApp(await userWithRole(['admin']));
    for (const url of ['/Supplier', '/Supplier/Supplier', '/SupplierProduct', '/SupplierProduct/5']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<div id="app">');
      expect(res.body).toContain('isAdmin = true;');
      expect(res.body).toMatch(/var userName = '[^']+';/);
    }
    await app.close();
  });

  it('store validation, create/update dirty check, messages, list filter/sort/page, getAjax, delete', async () => {
    const admin = await userWithRole(['admin']);
    const app = buildApp(admin);
    const supplier = `${PREFIX}s`;

    // validation: errors map only (Laravel 5.4 JsonResponse), HTML -> redirect back
    let res = await app.inject({ method: 'POST', url: '/api/supplierproducts', headers: JSON_HDR, payload: '{}' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ name: ['The name field is required.'], supplier: ['The supplier field is required.'] });
    res = await app.inject({ method: 'POST', url: '/api/supplierproducts', headers: JSON_HDR, payload: JSON.stringify({ name: 'x'.repeat(201), supplier }) });
    expect(res.json()).toEqual({ name: ['The name may not be greater than 200 characters.'] });
    res = await app.inject({ method: 'POST', url: '/api/supplierproducts', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(302);

    // create: key order = attributes, updated_at, created_at, id
    res = await app.inject({ method: 'POST', url: '/api/supplierproducts', headers: JSON_HDR, payload: JSON.stringify({ name: `${PREFIX} widget`, supplier }) });
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(Object.keys(created)).toEqual(['name', 'supplier', 'entry_by', 'updated_at', 'created_at', 'id']);
    expect(created.entry_by).toBe(admin.username);
    const id = created.id as number;
    const dbRow = await db.selectFrom('os_supplier_products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(dbRow.name).toBe(`${PREFIX} widget`);
    expect(dbRow.status).toBeNull();

    // update with nothing changed: not dirty -> updated_at untouched, full-column JSON
    await db.updateTable('os_supplier_products').set({ updated_at: '2001-02-03 04:05:06' } as never).where('id', '=', id).execute();
    res = await app.inject({ method: 'POST', url: `/api/supplierproduct/${id}`, headers: JSON_HDR, payload: JSON.stringify({ name: `${PREFIX} widget`, supplier }) });
    expect(Object.keys(res.json())).toEqual(['id', 'name', 'created_at', 'updated_at', 'supplier', 'entry_by', 'status']);
    expect(res.json().updated_at).toBe('2001-02-03 04:05:06');

    // update: missing supplier is assigned null (kept quirk), status set, updated_at stamped
    res = await app.inject({ method: 'POST', url: `/api/supplierproduct/${id}`, headers: JSON_HDR, payload: JSON.stringify({ name: `${PREFIX} widget2`, status: 'Active' }) });
    expect(res.json()).toMatchObject({ id, name: `${PREFIX} widget2`, supplier: null, status: 'Active' });
    expect(res.json().updated_at).not.toBe('2001-02-03 04:05:06');
    res = await app.inject({ method: 'POST', url: '/api/supplierproduct/999999999', headers: JSON_HDR, payload: '{}' });
    expect(res.statusCode).toBe(404);
    await db.updateTable('os_supplier_products').set({ supplier } as never).where('id', '=', id).execute();

    // messages
    res = await app.inject({ method: 'POST', url: `/api/supplierproduct/${id}/messages`, headers: JSON_HDR, payload: JSON.stringify({ message: 'hello' }) });
    expect(Object.keys(res.json())).toEqual(['supplier_product_id', 'message', 'entry_by', 'updated_at', 'created_at', 'id']);
    expect(res.json()).toMatchObject({ supplier_product_id: String(id), message: 'hello', entry_by: admin.username });
    res = await app.inject({ method: 'GET', url: `/api/supplierproduct/${id}/messages` });
    expect(res.json()).toHaveLength(1);
    expect(Object.keys(res.json()[0])).toEqual(['id', 'supplier_product_id', 'message', 'entry_by', 'created_at', 'updated_at']);

    // getAjax with relations; list (filter/sort/page)
    res = await app.inject({ method: 'GET', url: `/api/supplierproduct/${id}` });
    const one = res.json();
    expect(Object.keys(one).slice(-2)).toEqual(['messages', 'images']);
    expect(one.messages).toHaveLength(1);
    expect(one.images).toEqual([]);
    res = await app.inject({ method: 'GET', url: `/api/supplierproducts?filter=${PREFIX}&sort=name&order=DESC&page=1&pageSize=5` });
    expect(res.json().total).toBe(1);
    expect(res.json().products[0].id).toBe(id);
    expect(res.json().products[0].messages).toHaveLength(1);
    res = await app.inject({ method: 'GET', url: `/api/supplierproducts?filter=${PREFIX}&page=2&pageSize=1` });
    expect(res.json()).toMatchObject({ total: 1, products: [] });
    res = await app.inject({ method: 'GET', url: `/api/supplierproducts?filter=${PREFIX}&page=1&pageSize=-1` });
    expect(res.statusCode).toBe(500); // offset without LIMIT
    res = await app.inject({ method: 'GET', url: '/api/supplierproduct/999999999' });
    expect(res.statusCode).toBe(404);

    // delete product removes messages
    res = await app.inject({ method: 'DELETE', url: `/api/supplierproduct/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toBe('"ok"');
    expect(await db.selectFrom('os_supplier_product_messages').select('id').where('supplier_product_id', '=', String(id)).execute()).toEqual([]);
    res = await app.inject({ method: 'DELETE', url: `/api/supplierproduct/${id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('non-admin/user (supplier role) only sees own products', async () => {
    const now = '2020-01-01 00:00:00';
    const username = `${PREFIX}sup`;
    const ins = await db.insertInto('os_users').values({ username, email: `${username}@x.test`, password: 'x', confirmation_code: '', created_at: now } as never).executeTakeFirstOrThrow();
    const uid = Number(ins.insertId);
    await db.insertInto('os_user_has_roles').values({ role_id: 6, user_id: uid } as never).execute();
    const mk = (supplier: string) =>
      db.insertInto('os_supplier_products').values({ name: `${PREFIX} p`, supplier, created_at: now, updated_at: now } as never).executeTakeFirstOrThrow();
    const a = await mk(username);
    const b = await mk(`${PREFIX}other`);
    try {
      const app = buildApp({ id: uid });
      const res = await app.inject({ method: 'GET', url: `/api/supplierproducts?filter=${PREFIX}` });
      expect(res.json().total).toBe(1);
      expect(res.json().products.map((p: { id: number }) => p.id)).toEqual([Number(a.insertId)]);
      const page = await app.inject({ method: 'GET', url: '/Supplier' });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('isAdmin = true;');
      expect(page.body).toContain("var userFirstRole = 'supplier';");
      await app.close();
    } finally {
      await db.deleteFrom('os_supplier_products').where('id', 'in', [Number(a.insertId), Number(b.insertId)]).execute();
      await db.deleteFrom('os_user_has_roles').where('user_id', '=', uid).execute();
      await db.deleteFrom('os_users').where('id', '=', uid).execute();
    }
  });

  it('image upload (both disks), no-files 500, deleteImage orphans the icon, deleteProduct cleans up', async () => {
    const app = buildApp(await userWithRole(['admin']));
    const created = await app.inject({ method: 'POST', url: '/api/supplierproducts', headers: JSON_HDR, payload: JSON.stringify({ name: `${PREFIX} img`, supplier: `${PREFIX}s` }) });
    const id = created.json().id as number;

    const boundary = '----t30';
    const send = (files: { name: string; filename: string; buffer: Buffer }[]) =>
      app.inject({
        method: 'POST',
        url: `/api/supplierproduct/${id}/images`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, { x: '1' }, files),
      });
    let res = await send([]);
    expect(res.statusCode).toBe(500);
    res = await send([{ name: 'files', filename: 'a.png', buffer: PNG }, { name: 'files', filename: 'b.PNG', buffer: PNG }]);
    expect(res.statusCode).toBe(200);
    const names = res.json() as string[];
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(new RegExp(`^${id}_\\d+\\.0\\.png$`));
    expect(names[1]).toMatch(new RegExp(`^${id}_\\d+\\.1\\.PNG$`));
    for (const n of names) {
      expect(await supFull.exists(n)).toBe(true);
      expect(await supIcon.exists(n)).toBe(true);
    }
    const rows = await db.selectFrom('os_supplier_product_images').selectAll().where('supplier_product_id', '=', String(id)).execute();
    expect(rows.map((r) => r.original_name)).toEqual(['a.png', 'b.PNG']);

    res = await app.inject({ method: 'DELETE', url: `/api/supplierproduct/${id}/images/${rows[0].id}` });
    expect(res.body).toBe('"ok"');
    expect(await supFull.exists(names[0])).toBe(false);
    expect(await supIcon.exists(names[0])).toBe(true); // orphaned, kept quirk
    await supIcon.delete(names[0]);

    res = await app.inject({ method: 'DELETE', url: `/api/supplierproduct/${id}` });
    expect(res.body).toBe('"ok"');
    for (const n of names) {
      expect(await supFull.exists(n)).toBe(false);
      expect(await supIcon.exists(n)).toBe(false);
    }
    expect(await db.selectFrom('os_supplier_product_images').select('id').where('supplier_product_id', '=', String(id)).execute()).toEqual([]);
    await app.close();
  });
});

describe('T30 ProductImage', () => {
  it('getUpload 500 (missing view), upload/onServer/delete round trip, error branches', async () => {
    const app = buildApp(await userWithRole(['admin']));
    let res = await app.inject({ method: 'GET', url: '/productImage' });
    expect(res.statusCode).toBe(500);

    const pid = `${PREFIX}p`;
    const boundary = '----t30b';
    const post = (fields: Record<string, string>, files: { name: string; filename: string; buffer: Buffer }[]) =>
      app.inject({
        method: 'POST',
        url: '/productImageUpload',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, fields, files),
      });
    res = await post({ product_id: pid }, []);
    expect(res.statusCode).toBe(500);
    res = await post({}, [{ name: 'file', filename: 'x.png', buffer: PNG }]);
    expect(res.statusCode).toBe(500);

    res = await post({ product_id: pid }, [{ name: 'file', filename: "My_Photo (1).PNG", buffer: PNG }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: false, code: 200 });
    const filename = `${pid}_myphoto-1.PNG`;
    const row = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', pid).executeTakeFirstOrThrow();
    expect(row.filename).toBe(filename);
    expect(row.original_name).toBe('My_Photo (1).PNG');
    expect(await prodFull.exists(filename)).toBe(true);
    expect(await prodIcon.exists(filename)).toBe(true);

    res = await app.inject({ method: 'GET', url: `/productImageOnServer?product_id=${pid}` });
    expect(res.json()).toEqual({
      images: [{ original: 'My_Photo (1).PNG', server: expect.stringMatching(new RegExp(`^https?://[^/]+/storage/product_images_icon/${filename.replace(/[.()]/g, '\\$&')}$`)), size: (await prodFull.get(filename)).length }],
    });
    res = await app.inject({ method: 'GET', url: '/productImageOnServer' });
    expect(res.json()).toEqual({ images: [] });

    // delete: no product_id -> bare "0"; unknown -> 400; hit -> files + row gone
    res = await app.inject({ method: 'POST', url: '/productImageUploadDelete' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('0');
    res = await app.inject({ method: 'POST', url: '/productImageUploadDelete', headers: JSON_HDR, payload: JSON.stringify({ product_id: pid, filename: 'nope' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: true, code: 400 });
    res = await app.inject({ method: 'POST', url: '/productImageUploadDelete', headers: JSON_HDR, payload: JSON.stringify({ product_id: pid, filename: 'My_Photo (1).PNG' }) });
    expect(res.json()).toEqual({ error: false, code: 200 });
    expect(await prodFull.exists(filename)).toBe(false);
    expect(await prodIcon.exists(filename)).toBe(false);
    expect(await db.selectFrom('os_product_images').select('id').where('product_id', '=', pid).execute()).toEqual([]);

    // a second upload of a name whose `<pid>.<ext>` exists would get a -xxxxx token; extension-less names lose a char
    await prodFull.put(`${pid}.png`, PNG);
    res = await post({ product_id: pid }, [{ name: 'file', filename: 'plain.png', buffer: PNG }]);
    const second = await db.selectFrom('os_product_images').select('filename').where('product_id', '=', pid).executeTakeFirstOrThrow();
    expect(second.filename).toMatch(new RegExp(`^${pid}_plain-[0-9a-f]{5}\\.png$`));
    await prodFull.delete(`${pid}.png`);
    await app.close();
  });
});

describe('T30 Faire image import', () => {
  it('jobsFromRows: variant images beat product images, sequence order, dedupe, skips, sku filter', () => {
    const rows = [
      {
        id: 'f1',
        images: JSON.stringify([{ url: 'https://x/2.jpg', sequence: 2 }, { url: 'https://x/1.jpg', sequence: 1 }, { url: 'https://x/1.jpg' }, { url: '' }]),
        variants: JSON.stringify([{ sku: ' A1 ' }, { sku: 'B2', images: [{ url: 'https://x/v.jpg' }] }, { sku: '' }, { sku: 'A1' }, { sku: 'C3', images: [] }]),
      },
      { id: 'f2', images: null, variants: [{ sku: 'D4' }] },
      { id: 'f3', images: '[]', variants: 'not json' },
    ];
    expect(jobsFromRows(rows)).toEqual({
      jobs: [
        { sku: 'A1', image_urls: ['https://x/1.jpg', 'https://x/2.jpg'], faire_product_id: 'f1' },
        { sku: 'B2', image_urls: ['https://x/v.jpg'], faire_product_id: 'f1' },
        { sku: 'C3', image_urls: ['https://x/1.jpg', 'https://x/2.jpg'], faire_product_id: 'f1' },
      ],
      skipped_no_sku: 1,
      skipped_no_urls: 1,
    });
    expect(jobsFromRows(rows, 'B2').jobs.map((j) => j.sku)).toEqual(['B2']);
  });

  it('endpoint: wrong/missing token -> 401 JSON; right token -> dry-run summary', async () => {
    const app = buildApp(await userWithRole(['admin']));
    let res = await app.inject({ method: 'POST', url: '/api/products/import-faire-images', headers: JSON_HDR, payload: '{}' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    res = await app.inject({ method: 'POST', url: '/api/products/import-faire-images', headers: { ...JSON_HDR, 'x-import-token': 'nope' }, payload: '{}' });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: 'POST', url: '/api/products/import-faire-images', headers: { ...JSON_HDR, 'x-import-token': 't30-token' }, payload: JSON.stringify({ sku: `${PREFIX}nomatch`, dry_run: 'true' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, imported: 0, replaced: 0, not_found: 0, errors: [], jobs: [] });
    await app.close();
  });

  it('import: not_found, dry-run planned, real import replaces existing images (download stubbed)', async () => {
    const sku = `${PREFIX}SKU`;
    const faireId = `${PREFIX}f`;
    await db.insertInto('os_faire_products').values({
      id: faireId,
      variants: JSON.stringify([{ sku, images: [{ url: 'https://img.test/a/one.jpeg', sequence: 1 }, { url: 'https://img.test/a/two.png', sequence: 2 }] }, { sku: `${PREFIX}MISSING` }]),
      images: JSON.stringify([{ url: 'https://img.test/a/prod.jpg' }]),
    } as never).execute();
    const pr = await db.insertInto('os_products').values({ name: `${PREFIX} faire`, sku, created_at: '2020-01-01 00:00:00', updated_at: '2020-01-01 00:00:00' } as never).executeTakeFirstOrThrow();
    const productId = Number(pr.insertId);
    // pre-existing image to be replaced
    await prodFull.put(`${productId}_old.jpg`, PNG);
    await prodIcon.put(`${productId}_old.jpg`, PNG);
    await db.insertInto('os_product_images').values({ product_id: String(productId), original_name: 'old.jpg', filename: `${productId}_old.jpg`, created_at: '2020-01-01 00:00:00', updated_at: '2020-01-01 00:00:00' } as never).execute();
    const written: string[] = [];
    try {
      const dry = await importFaireImages(sku, true);
      expect(dry).toMatchObject({ dry_run: true, imported: 0 });
      expect(dry.jobs).toEqual([{ sku, faire_product_id: faireId, image_urls: ['https://img.test/a/one.jpeg', 'https://img.test/a/two.png'], product_id: productId, status: 'planned' }]);

      const all = await importFaireImages(null, true);
      const mine = all.jobs.filter((j) => String(j['sku']).startsWith(PREFIX));
      expect(mine.map((j) => j['status'])).toEqual(['planned', 'not_found']);
      expect(mine[1]['product_id']).toBeNull();

      setFaireDownloadForTests(async (url) =>
        url.endsWith('two.png') ? null : { contents: PNG, ext: url.endsWith('.jpeg') ? 'jpg' : 'png', original_name: url.split('/').pop() ?? '' },
      );
      const real = await importFaireImages(sku, false);
      expect(real).toMatchObject({ imported: 1, replaced: 1, errors: [{ sku, url: 'https://img.test/a/two.png', error: 'download_failed' }] });
      expect(real.jobs[0]).toMatchObject({ status: 'imported', imported: 1, product_id: productId });
      const imgs = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(productId)).execute();
      expect(imgs).toHaveLength(1);
      expect(imgs[0].filename).toMatch(new RegExp(`^${productId}_\\d+\\.0\\.jpg$`));
      expect(imgs[0].original_name).toBe('one.jpeg');
      written.push(imgs[0].filename);
      expect(await prodFull.exists(imgs[0].filename)).toBe(true);
      expect(await prodIcon.exists(imgs[0].filename)).toBe(true);
      expect(await prodFull.exists(`${productId}_old.jpg`)).toBe(false);

      setFaireDownloadForTests(async () => null);
      const failed = await importFaireImages(sku, false);
      expect(failed.jobs[0]).toMatchObject({ status: 'download_failed' });
      expect(await db.selectFrom('os_product_images').select('id').where('product_id', '=', String(productId)).execute()).toHaveLength(1);
    } finally {
      setFaireDownloadForTests(null);
      for (const f of [...written, `${productId}_old.jpg`]) {
        await prodFull.delete(f);
        await prodIcon.delete(f);
      }
      await db.deleteFrom('os_product_images').where('product_id', '=', String(productId)).execute();
      await db.deleteFrom('os_products').where('id', '=', productId).execute();
      await db.deleteFrom('os_faire_products').where('id', '=', faireId).execute();
    }
  });
});
