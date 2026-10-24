// T41: WayfairController + TongtoolController (routes/web.php:465-472,
// role:admin,user,remote). Safe read routes are inject-tested; the external-API
// routes (/Wayfair.registerOrder, /Wayfair.packingSlip) are NOT called (no
// external calls) — code review only.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerTongtoolRoutes } from '../src/modules/tongtool/routes.js';
import { registerWayfairRoutes } from '../src/modules/wayfair/routes.js';
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

function buildApp(user: Row | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(multipart, { attachFieldsToBody: false });
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerWayfairRoutes(app);
  registerTongtoolRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

async function xlsxBuffer(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function multipartReport(boundary: string, content: string | Buffer, filename: string): Buffer {
  const bin = Buffer.isBuffer(content) ? content : Buffer.from(content, 'binary');
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="report"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    bin.toString('binary'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(body, 'binary');
}

describe('T41 wayfair + tongtool (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const app = buildApp(null);
    for (const url of ['/Wayfair', '/Tongtool', '/Wayfair.picklist', '/Tongtool.picklist']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toContain('/login');
    }

    const noRole = await userWithoutRole();
    if (noRole) {
      const app2 = buildApp(noRole);
      for (const url of ['/Wayfair', '/Tongtool', '/Wayfair.picklist', '/Tongtool.picklist']) {
        const r = await app2.inject({ method: 'GET', url });
        expect(r.statusCode).toBe(403);
        expect(r.body).toBe('No Access.');
      }
      await app2.close();
    }
    await app.close();
  });

  it('index pages render; missing resource actions 500.', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const wf = await app.inject({ method: 'GET', url: '/Wayfair' });
    expect(wf.statusCode).toBe(200);
    expect(wf.body).toContain('saveNewButton2');
    expect(wf.body).toContain('/Wayfair.store');
    expect(wf.body).toContain('/Wayfair.picklist');

    const tt = await app.inject({ method: 'GET', url: '/Tongtool' });
    expect(tt.statusCode).toBe(200);
    expect(tt.body).toContain('saveNewButton');
    expect(tt.body).toContain('/Tongtool.picklist');

    // create/show/edit do not exist on either old controller -> 500.
    for (const url of ['/Wayfair/create', '/Wayfair/1', '/Wayfair/1/edit', '/Tongtool/create', '/Tongtool/1']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(500);
    }
    await app.close();
  });

  it('picklist with no file returns [] (the safe-GET parity case).', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    expect((await app.inject({ method: 'GET', url: '/Wayfair.picklist' })).body).toBe('[]');
    expect((await app.inject({ method: 'GET', url: '/Tongtool.picklist' })).body).toBe('[]');
    await app.close();
  });

  it('Tongtool.picklist (noHeading xlsx) maps d[1] to the product (with locations).', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const skuRow = (
      await db
        .selectFrom('os_products')
        .innerJoin('os_product_locations', 'os_product_locations.product_id', 'os_products.id')
        .select(['os_products.sku'])
        .where('os_products.sku', 'is not', null)
        .limit(1)
        .executeTakeFirst()
    );
    if (!skuRow) throw new Error('no sku with a location in DB');
    const sku = String(skuRow.sku);
    const app = buildApp(user);
    const buf = await xlsxBuffer([
      ['col0', 'SKU', 'col2', 'col3', 'col4'],
      ['x', sku, 'n', 'l', 'q'],
    ]);
    const r = await app.inject({
      method: 'POST',
      url: '/Tongtool.picklist',
      headers: { 'content-type': `multipart/form-data; boundary=t41b` },
      payload: multipartReport('t41b', buf, 'report.xlsx'),
    });
    expect(r.statusCode).toBe(200);
    const rows = JSON.parse(r.body) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]['1']).toBe(sku);
    const product = rows[0]['product'] as Record<string, unknown> | null;
    expect(product?.sku).toBe(sku);
    expect(Array.isArray(product?.locations)).toBe(true);
    await app.close();
  });

  it('Wayfair.store parses the CSV into regdatesList (product + qty accumulation).', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const skuRow = (
      await db
        .selectFrom('os_products')
        .innerJoin('os_product_locations', 'os_product_locations.product_id', 'os_products.id')
        .select(['os_products.sku'])
        .where('os_products.sku', 'is not', null)
        .limit(1)
        .executeTakeFirst()
    );
    if (!skuRow) throw new Error('no sku with a location in DB');
    const sku = String(skuRow.sku);
    const app = buildApp(user);
    const csv = [
      'Item Number,Item Name,Quantity,Registered Timestamp,PO Number,Ship To Name,Packing Slip URL',
      `"${sku}=",N,2,2024-01-15 10:00:00,PO1,John,http`,
      `"${sku}=",N,3,2024-01-15 11:00:00,PO1,John,http`,
    ].join('\n');
    const r = await app.inject({
      method: 'POST',
      url: '/Wayfair.store',
      headers: { 'content-type': `multipart/form-data; boundary=t41c` },
      payload: multipartReport('t41c', csv, 'report.csv'),
    });
    expect(r.statusCode).toBe(200);
    const list = JSON.parse(r.body) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    const reg = list[0];
    expect(reg.reg).toBe('2024-01-15');
    expect(Object.keys(reg)).toEqual(['po', 'reg', 'sku']);
    const skus = reg.sku as Record<string, unknown>[];
    expect(skus).toHaveLength(1);
    expect(skus[0].sku).toBe(sku);
    expect(skus[0].qty).toBe(5); // '2' + '3'
    expect((skus[0].product as Record<string, unknown> | null)?.sku).toBe(sku);
    expect(Array.isArray((skus[0].product as Record<string, unknown>)?.images)).toBe(true);
    const pos = reg.po as Record<string, unknown>[];
    expect(pos).toHaveLength(2);
    expect(pos[0].po).toBe('PO1');
    expect(pos[0].qty).toBe('2');
    await app.close();
  });
});
