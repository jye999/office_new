// T17: WindyController (/windy resource, /windy.index, /windy.export,
// /windy/{id}/delete, /windy/{id}/deleteMsg) + FourController (same for
// /four, plus /four.ebay). Store='WINDY'/'FOUR'.
// DB writes are insert-then-cleanup (T12/T13/T16 pattern); the store/ebay
// upload flows are NOT exercised (loadUnshipped would mark ~60k live rows
// Done) — code review + manual checklist only.

import fastifyMultipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { parseItems } from '../src/lib/grantOrders.js';
import { registerFourRoutes } from '../src/modules/four/routes.js';
import { registerWindyRoutes } from '../src/modules/windy/routes.js';
import { registerViewPlugins } from '../src/view.js';

async function userWithRole(roles: string[]) {
  return (
    (await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()) ?? null
  );
}

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(fastifyMultipart);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerWindyRoutes(app);
  registerFourRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

const BASE = 'http://localhost:7000';

describe('T17 windy / four (fastify inject)', () => {
  afterAll(async () => {
    await db.destroy();
  });

  it('role guards: anon -> 302 /login, supplier -> 403 No Access.', async () => {
    const anon = buildApp(null);
    let out = await anon.inject({ method: 'GET', url: '/windy.index' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    out = await anon.inject({ method: 'GET', url: '/four.index' });
    expect(out.statusCode).toBe(302);
    await anon.close();

    const supplier = await userWithRole(['supplier']);
    if (supplier) {
      const app = buildApp(supplier);
      out = await app.inject({ method: 'GET', url: '/windy.index' });
      expect(out.statusCode).toBe(403);
      expect(out.body).toBe('No Access.');
      out = await app.inject({ method: 'GET', url: '/four.index' });
      expect(out.statusCode).toBe(403);
      await app.close();
    }
  });

  it('/windy.index renders the orders page; ?status=processed swaps tabs + export form.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/windy.index' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('id="noshipped" class="active"');
    expect(out.body).toContain('id="shipped" class=""');
    expect(out.body).toContain(`action = '${BASE}/windy'`);
    expect(out.body).toContain(`${BASE}/windy.index`);
    expect(out.body).toContain(`${BASE}/windy.index?status=processed`);
    expect(out.body).not.toContain(`action = '${BASE}/windy.export'`);
    expect(out.body).not.toContain('id="ship_startdate"');
    // A real null-status WINDY order row renders (390 exist in the DB).
    const order = await db
      .selectFrom('os_grant_order')
      .innerJoin('os_grant_orderdetail', 'os_grant_orderdetail.orderId', 'os_grant_order.orderId')
      .where('os_grant_order.store', '=', 'WINDY')
      .where('os_grant_order.status', 'is', null)
      .select(['os_grant_order.orderId'])
      .orderBy('os_grant_order.created_at', 'desc')
      .executeTakeFirst();
    if (order) expect(out.body).toContain(`>${order.orderId}<`);
    out = await app.inject({ method: 'GET', url: '/windy.index?status=processed' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('id="noshipped" class=""');
    expect(out.body).toContain('id="shipped" class="active"');
    expect(out.body).toContain(`action = '${BASE}/windy.export'`);
    await app.close();
  });

  it('/four.index renders (store FOUR is empty) with the commented ebay form.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/four.index' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain(`action = '${BASE}/four'`);
    expect(out.body).toContain('Upload Amazon');
    // Blade compiles {!! !!} inside the HTML comment too — the URL must appear.
    expect(out.body).toContain(`action = '${BASE}/four.ebay'`);
    expect(out.body).toContain('id="noshipped" class="active"');
    await app.close();
  });

  it('deleteMsg: XHR -> Ajaxis modal, non-XHR -> empty 200.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({
      method: 'GET',
      url: '/windy/12345/deleteMsg',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('<div class="modal-dialog" role="document">');
    expect(out.body).toContain('Would you like to remove This?');
    expect(out.body).toContain('data-link = "/windy/12345/delete"');
    expect(out.body).toContain('>Agree</button>');
    out = await app.inject({ method: 'GET', url: '/four/67890/deleteMsg', headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('data-link = "/four/67890/delete"');
    out = await app.inject({ method: 'GET', url: '/windy/12345/deleteMsg' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('');
    await app.close();
  });

  it('export: CSV of tracked WINDY orders with the PHP headers; empty range is header-only.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({
      method: 'POST',
      url: '/windy.export',
      payload: { ship_startdate: '2000-01-01', ship_enddate: '2030-01-01' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.headers['content-type']).toBe('text/csv');
    expect(out.headers['content-disposition']).toBe('attachment; filename=orders.txt');
    expect(out.headers['cache-control']).toBe('must-revalidate, post-check=0, pre-check=0');
    const lines = out.body.split('\r\n');
    expect(lines[0]).toBe('"order-id"\t"order-item-id"\t"quantity"\t"ship-date"\t"carrier-code"\t"carrier-name"\t"tracking-number"\t"ship-method"');
    // Cross-check the row count against the same raw SQL the PHP runs.
    const { sql } = await import('../src/db.js');
    const rows = (await sql`select 1 as one from os_trackings ot
      inner join os_grant_orderdetail ogod on ot.orderId = ogod.orderId
      where ogod.store='WINDY'
        and date(ot.created_at) between '2000-01-01' and '2030-01-01'`.execute(db)).rows;
    expect(lines.length - 2).toBe(rows.length); // - header, - trailing CRLF piece
    if (rows.length) expect(lines[1].startsWith('"')).toBe(true);
    out = await app.inject({
      method: 'POST',
      url: '/windy.export',
      payload: { ship_startdate: '1990-01-01', ship_enddate: '1990-12-31' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(`${lines[0]}\r\n`);
    await app.close();
  });

  it('destroy: deletes grant_orderdetail + grant_order for store + orderId, echoes the index URL.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const orderId = `t17-test-${Date.now()}`;
    const detailId = 't17-item-1';
    const ts = '2000-01-01 00:00:00';
    try {
      for (const [store, path] of [
        ['WINDY', `/windy/${orderId}/delete`],
        ['FOUR', `/four/${orderId}/delete`],
      ] as const) {
        await db
          .insertInto('os_grant_order')
          .values({ store, orderId, recipientName: 'T17', created_at: ts as never, updated_at: ts as never })
          .execute();
        await db
          .insertInto('os_grant_orderdetail')
          .values({ store, orderId, itemId: detailId, name: 'T17', qty: 1, created_at: ts as never, updated_at: ts as never })
          .execute();
        const del = await app.inject({ method: 'GET', url: path });
        expect(del.statusCode).toBe(200);
        expect(del.headers['content-type']).toContain('text/html');
        expect(del.body).toBe(`${BASE}/${store === 'WINDY' ? 'windy' : 'four'}.index`);
        const remaining = await db
          .selectFrom('os_grant_order')
          .select('id')
          .where('store', '=', store)
          .where('orderId', '=', orderId)
          .execute();
        expect(remaining).toHaveLength(0);
        const remainingDetail = await db
          .selectFrom('os_grant_orderdetail')
          .select('id')
          .where('store', '=', store)
          .where('orderId', '=', orderId)
          .execute();
        expect(remainingDetail).toHaveLength(0);
      }
    } finally {
      await db.deleteFrom('os_grant_order').where('orderId', '=', orderId).execute();
      await db.deleteFrom('os_grant_orderdetail').where('orderId', '=', orderId).execute();
    }
    await app.close();
  });

  it('parseItems: tab TSV first-line header, equal-width rows only; no data rows -> undefined.', () => {
    // Row with 3 fields vs 2 header fields is dropped, like PHP's sizeof check.
    const items = parseItems('order-id\tqty\n123\t2\n456\t7\t8\n456\t7\n');
    expect(items).toEqual([{ 'order-id': '123', qty: '2' }, { 'order-id': '456', qty: '7' }]);
    // Trailing newline: the empty line has 1 field like the 1-field header,
    // so PHP (and this port) keeps one junk item — kept as-is.
    expect(parseItems('only-a-header\n')).toEqual([{ 'only-a-header': '' }]);
    expect(parseItems('')).toBeUndefined();
  });
});
