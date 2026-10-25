// T23: OrderController (routes/web.php:298-303, 336-339; api.php:56,
// role:admin,user,remote). Mutating routes are exercised with a temporary
// os_grant_order row cleaned up via the module's own delete route (T13/T17/T20
// pattern).

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerOrderRoutes } from '../src/modules/order/routes.js';
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
  registerOrderRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T23 order module (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    for (const u of ['/order', '/packing', '/pickList', '/printing', '/api/orders']) {
      const out = await anon.inject({ method: 'GET', url: u });
      expect(out.statusCode).toBe(302);
      expect(out.headers['location']).toBe('http://localhost:80/login');
    }
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      for (const u of ['/order', '/packing', '/pickList', '/printing', '/api/orders']) {
        const res = await app.inject({ method: 'GET', url: u });
        expect(res.statusCode).toBe(403);
        expect(res.body).toBe('No Access.');
      }
      await app.close();
    }
  });

  it('GET /order, /order/create, edit, show, deleteMsg render like the old views', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const idx = await app.inject({ method: 'GET', url: '/order' });
    expect(idx.statusCode).toBe(200);
    expect(idx.body).toContain('Create New order');
    expect(idx.body).toContain('table-striped');

    const create = await app.inject({ method: 'GET', url: '/order/create' });
    expect(create.statusCode).toBe(200);
    expect(create.body).toContain('Create Order');
    // create.blade's extra `}` after the token value is kept.
    expect(create.body).toMatch(/name = '_token' value = '[0-9a-f]+}\'>/);

    const row = (
      await sql`select id, orderId from os_grant_order where status is null order by id desc limit 1`.execute(db)
    ) as { rows: { id: number; orderId: string }[] };
    expect(row.rows.length).toBeGreaterThan(0);

    const edit = await app.inject({ method: 'GET', url: `/order/${row.rows[0].id}/edit` });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toContain('Edit Order');
    // edit.blade references the (nonexistent) name/val columns.
    expect(edit.body).toContain('name = "name"');
    expect(edit.body).toContain('name = "val"');
    // orderId (not the numeric id) from the {id} route.
    const show = await app.inject({ method: 'GET', url: `/order/${row.rows[0].orderId}` });
    expect(show.statusCode).toBe(200);
    expect(show.body).toContain('id="orders"');

    // deleteMsg: Ajaxis modal linking to the /funny/ copy-paste path.
    const delMsg = await app.inject({
      method: 'GET',
      url: `/order/${row.rows[0].id}/deleteMsg`,
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(delMsg.statusCode).toBe(200);
    expect(delMsg.body).toContain(`/funny/${row.rows[0].id}/delete`);
    await app.close();
  });

  it('GET /api/orders returns every null-status order + detail as JSON', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const out = await app.inject({ method: 'GET', url: '/api/orders' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as { total: number; orders: Record<string, unknown>[] };
    const direct = (
      await sql`select count(*) as total from os_grant_order where status is null`.execute(db)
    ) as { rows: { total: number }[] };
    expect(body.total).toBe(direct.rows[0].total);
    expect(body.orders.length).toBe(body.total);
    // Eloquent attribute order: id first, orderId before store.
    expect(Object.keys(body.orders[0]).slice(0, 3)).toEqual(['id', 'store', 'orderId']);
    // details are re-keyed (asin before qty).
    const first = body.orders[0];
    if (Array.isArray(first.detail) && (first.detail as unknown[]).length > 0) {
      expect(Object.keys((first.detail as Record<string, unknown>[])![0]).slice(0, 7)).toEqual([
        'id', 'store', 'orderId', 'subOrderId', 'itemId', 'asin', 'name',
      ]);
    }
    // reading $i->ProductMap loads the relation: `product_map` (null or object) is serialised
    // exactly for details whose image is empty after the local-image/product-image fallback
    for (const o of body.orders) {
      for (const d of o.detail as Record<string, unknown>[]) {
        if (d.image == null || d.image === '') expect(d.product_map === null || typeof d.product_map === 'object').toBe(true);
        if ('product_map' in d && d.product_map === null) expect(d.image == null || d.image === '').toBe(true);
      }
    }
    expect(JSON.stringify(body.orders)).toContain('"product_map":null');
    await app.close();
  });

  it('POST /getMultiOrders: array input -> orders JSON; scalar -> 500 (whereIn fatal)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const row = (
      await sql`select orderId from os_grant_order order by id limit 1`.execute(db)
    ) as { rows: { orderId: string }[] };
    const out = await app.inject({
      method: 'POST',
      url: '/getMultiOrders',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `orders[]=${encodeURIComponent(row.rows[0].orderId)}`,
    });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>[];
    expect(body.length).toBe(1);
    expect(body[0].orderId).toBe(row.rows[0].orderId);

    const bad = await app.inject({
      method: 'POST',
      url: '/getMultiOrders',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'orders=scalar',
    });
    expect(bad.statusCode).toBe(500);
    await app.close();
  });

  it('/packing renders the print slip; /printing GET renders the empty label view', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const row = (
      await sql`select orderId from os_grant_order order by id limit 1`.execute(db)
    ) as { rows: { orderId: string }[] };
    const packing = await app.inject({ method: 'GET', url: `/packing?id=${encodeURIComponent(row.rows[0].orderId)}` });
    expect(packing.statusCode).toBe(200);
    expect(packing.body).toContain('RETURN POLICY');
    expect(packing.body).toContain(`Order ID: ${row.rows[0].orderId}`);

    const printing = await app.inject({ method: 'GET', url: '/printing' });
    expect(printing.statusCode).toBe(200);
    // no orders -> empty label view (the img tag only renders per order).
    expect(printing.body).toContain('3.812in');
    expect(printing.body).not.toContain('<img');
    await app.close();
  });

  it('/pickList: bad store redirects back; groupBy=customer is empty 200; groupBy=item 500s (hwc products table absent)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const row = (
      await sql`select orderId from os_grant_order order by id limit 1`.execute(db)
    ) as { rows: { orderId: string }[] };
    const o = row.rows[0].orderId;

    const bad = await app.inject({ method: 'GET', url: `/pickList?id=${encodeURIComponent(o)}&store=nope` });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers['location']).toBe('http://localhost:80/'); // no Referer -> app root

    const customer = await app.inject({
      method: 'GET',
      url: `/pickList?id=${encodeURIComponent(o)}&store=WINDY&groupBy=customer`,
    });
    expect(customer.statusCode).toBe(200);
    expect(customer.body).toBe('');

    const item = await app.inject({
      method: 'GET',
      url: `/pickList?id=${encodeURIComponent(o)}&store=WINDY&groupBy=item`,
    });
    expect(item.statusCode).toBe(500);
    await app.close();
  });

  it('/pickList?groupBy=order renders orders sorted by sum(qty)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const row = (
      await sql`select orderId from os_grant_order order by id limit 1`.execute(db)
    ) as { rows: { orderId: string }[] };
    const o = row.rows[0].orderId;
    const out = await app.inject({
      method: 'GET',
      url: `/pickList?id=${encodeURIComponent(o)}&store=mermaid&groupBy=order`,
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Order ID');
    expect(out.body).toContain(o);
    await app.close();
  });

  it('order store -> update -> delete lifecycle (temp row cleaned up)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    // no orderId -> explicit NULL into a NOT NULL column fails even in non-strict mode -> 500, same as the old app.
    const bad = await app.inject({
      method: 'POST',
      url: '/order',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'recipientName=t23-temp',
    });
    expect(bad.statusCode).toBe(500);

    // name/price are NOT NULL and never set: the old app's non-strict connection stores their defaults, so the
    // request succeeds (verified against the old app: 302 + a detail row with qty 2).
    const ok = await app.inject({
      method: 'POST',
      url: '/order',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'orderId=t23temp123&recipientName=t23-temp&address1=a&itemId[]=1&qty[]=2',
    });
    expect(ok.statusCode).toBe(302);
    const detail = await db.selectFrom('os_grant_orderdetail').select(['itemId', 'qty']).where('orderId', '=', 't23temp123').execute();
    expect(detail.map((d) => [d.itemId, d.qty])).toEqual([['1', 2]]);
    await db.deleteFrom('os_grant_orderdetail').where('orderId', '=', 't23temp123').execute();
    // itemId missing: sizeof(null) warning -> 500, but the order row is already saved.
    const noItems = await app.inject({ method: 'POST', url: '/order', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'orderId=t23temp124&recipientName=t23-temp' });
    expect(noItems.statusCode).toBe(500);
    await db.deleteFrom('os_grant_order').where('orderId', '=', 't23temp124').execute();
    const created = (
      await sql`select id from os_grant_order where orderId = 't23temp123'`.execute(db)
    ) as { rows: { id: number }[] };
    expect(created.rows.length).toBe(1);
    const id = created.rows[0].id;
    try {
      // update(): findOrFail + no-op save + redirect('order').
      const up = await app.inject({ method: 'POST', url: `/order/${id}/update` });
      expect(up.statusCode).toBe(302);
      expect(up.headers['location']).toBe('http://localhost:7000/order');
      // update of a missing row -> 404.
      const upMissing = await app.inject({ method: 'POST', url: '/order/999999/update' });
      expect(upMissing.statusCode).toBe(404);
    } finally {
      // destroy(): findOrFail + delete, body = URL::to('order').
      const del = await app.inject({ method: 'GET', url: `/order/${id}/delete` });
      expect(del.statusCode).toBe(200);
      expect(del.body).toBe('http://localhost:7000/order');
      const left = await db.selectFrom('os_grant_order').selectAll().where('id', '=', id).executeTakeFirst();
      expect(left).toBeUndefined();
    }
    await app.close();
  });
});
