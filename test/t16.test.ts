// T16: OpoloController (/opolo resource, /opolo.index, /opolo/{id}/delete,
// /opolo/{id}/deleteMsg) + OpoloCostController (/manage-opolo, /opolocost
// resource, /opolocost.show|store|update|destroy, /opolocost.ajaxData).
// DB writes are insert-then-cleanup (T12/T13 pattern).

import fastifyMultipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerOpoloRoutes } from '../src/modules/opolo/routes.js';
import { registerViewPlugins } from '../src/view.js';

async function userWithRole(roles: string[]) {
  return (
    await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()
  ) ?? null;
}

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(fastifyMultipart);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerOpoloRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

// url()/route() emit APP_URL (http://localhost:7000 in .env) like Laravel's
// request-root URLs do under parity.
const BASE = 'http://localhost:7000';

const TS = Date.now();

describe('T16 opolo / opolocost (fastify inject)', () => {
  afterAll(async () => {
    await db.destroy();
  });

  it('role guards: anon -> 302 /login, supplier -> 403 No Access.', async () => {
    const anon = buildApp(null);
    let out = await anon.inject({ method: 'GET', url: '/opolo.index' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    out = await anon.inject({ method: 'GET', url: '/opolocost' });
    expect(out.statusCode).toBe(302);
    await anon.close();

    const supplier = await userWithRole(['supplier']);
    if (supplier) {
      const app = buildApp(supplier);
      out = await app.inject({ method: 'GET', url: '/opolo.index' });
      expect(out.statusCode).toBe(403);
      expect(out.body).toBe('No Access.');
      out = await app.inject({ method: 'GET', url: '/manage-opolo' });
      expect(out.statusCode).toBe(403);
      await app.close();
    }
  });

  it('/opolo.index renders the orders page; ?status=processed swaps the active tab.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin ?? null);
    let out = await app.inject({ method: 'GET', url: '/opolo.index' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('id="noshipped" class="active"');
    expect(out.body).toContain('id="shipped" class=""');
    expect(out.body).toContain(`action = '${BASE}/opolo'`);
    expect(out.body).toContain(`href="${BASE}/opolo.index?status=processed"`);
    out = await app.inject({ method: 'GET', url: '/opolo.index?status=processed' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('id="noshipped" class=""');
    expect(out.body).toContain('id="shipped" class="active"');
    await app.close();
  });

  it('/opolo/{id}/deleteMsg: ajaxis modal HTML for ajax, empty for non-ajax.', async () => {
    const admin = await userWithRole(['admin']);
    const app = buildApp(admin);
    const out = await app.inject({
      method: 'GET',
      url: '/opolo/ORDER-123/deleteMsg',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.headers['content-type']).toContain('text/html');
    expect(out.body).toContain('<h4 class="modal-title" id="myModalLabel">Warning!!</h4>');
    expect(out.body).toContain('<div class="modal-body">Would you like to remove This?</div>');
    expect(out.body).toContain('data-link = "/opolo/ORDER-123/delete">Agree</button>');
    const plain = await app.inject({ method: 'GET', url: '/opolo/ORDER-123/deleteMsg' });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toBe('');
    await app.close();
  });

  it('/opolo/{id}/delete removes the order + detail rows by orderId (temp row).', async () => {
    const admin = await userWithRole(['admin']);
    const orderId = `t16test-${TS}`;
    await db.insertInto('os_grant_order').values({ store: 'O', orderId, status: null }).execute();
    await db
      .insertInto('os_grant_orderdetail')
      .values({ store: 'O', orderId, itemId: 'ITEM-T16', name: 'T16 Prod', asin: 'ASIN-T16', qty: 1 })
      .execute();
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: `/opolo/${orderId}/delete` });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(`${BASE}/opolo.index`);
    const order = await db.selectFrom('os_grant_order').select('id').where('orderId', '=', orderId).executeTakeFirst();
    const detail = await db.selectFrom('os_grant_orderdetail').select('id').where('orderId', '=', orderId).executeTakeFirst();
    expect(order).toBeUndefined();
    expect(detail).toBeUndefined();
    await app.close();
  });

  it('/manage-opolo 500s (the controller has no manageOpolo method).', async () => {
    const admin = await userWithRole(['admin']);
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/manage-opolo' });
    expect(out.statusCode).toBe(500);
    await app.close();
  });

  it('/opolocost renders and /opolocost.show returns the row JSON (or 404).', async () => {
    const admin = await userWithRole(['admin']);
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/opolocost' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('id="myTable"');
    expect(out.body).toContain(`ajax: '${BASE}/opolocost.ajaxData'`);
    out = await app.inject({ method: 'GET', url: '/opolocost.show?id=9' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>;
    expect(body['id']).toBe(9);
    expect(Object.keys(body)[0]).toBe('id'); // Eloquent: all columns, in order
    out = await app.inject({ method: 'GET', url: '/opolocost.show?id=9999999' });
    expect(out.statusCode).toBe(404);
    await app.close();
  });

  it('/opolocost.ajaxData returns the v6 protocol with ID: N and action buttons.', async () => {
    const admin = await userWithRole(['admin']);
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/opolocost.ajaxData?draw=1&start=0&length=10' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as { draw: number; recordsTotal: number; recordsFiltered: number; data: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['draw', 'recordsTotal', 'recordsFiltered', 'data']);
    expect(body.draw).toBe(1);
    expect(body.recordsTotal).toBeGreaterThan(0);
    const row = body.data[0];
    expect(String(row['id'])).toMatch(/^ID: \d+$/);
    expect(String(row['action'])).toContain('btnEdit');
    expect(String(row['action'])).toContain('btnDelete');
    await app.close();
  });

  it('store -> update -> destroy round-trip (temp row) with 422 validation.', async () => {
    const admin = await userWithRole(['admin']);
    const app = buildApp(admin);
    // no date -> 422
    let out = await app.inject({
      method: 'POST',
      url: '/opolocost.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'cost=5.5',
    });
    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      message: 'The date field is required.',
      errors: { date: ['The date field is required.'] },
    });
    // non-numeric cost -> 422 (rule order: date first, then cost)
    out = await app.inject({
      method: 'POST',
      url: '/opolocost.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'date=2024-01-01&cost=abc',
    });
    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body).errors).toEqual({ cost: ['The cost must be a number.'] });
    // valid -> row created, returned as the fresh model
    out = await app.inject({
      method: 'POST',
      url: '/opolocost.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `date=2024-01-01&description=t16test&category=Labor&cost=5.5`,
    });
    expect(out.statusCode).toBe(200);
    const created = JSON.parse(out.body) as Record<string, unknown>;
    const id = Number(created['id']);
    expect(id).toBeGreaterThan(0);
    expect(created['description']).toBe('t16test');
    expect(Object.keys(created)).toEqual(['id', 'date', 'description', 'category', 'cost', 'created_at', 'updated_at']);
    // update -> 1
    out = await app.inject({
      method: 'PUT',
      url: '/opolocost.update',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&date=2024-01-02&cost=6`,
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('1');
    const updated = await db.selectFrom('os_opolo_cost').select(['description', 'cost']).where('id', '=', id).executeTakeFirst();
    expect(updated?.description).toBe('t16test'); // not sent -> untouched
    expect(updated?.cost).toBe('6.00'); // DECIMAL returns as a string, like Laravel
    // update on missing row -> PHP fatal -> 500
    out = await app.inject({
      method: 'PUT',
      url: '/opolocost.update',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'id=9999999&date=2024-01-02',
    });
    expect(out.statusCode).toBe(500);
    // destroy -> {"0":"done"}
    out = await app.inject({
      method: 'DELETE',
      url: '/opolocost.destroy',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}`,
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('["done"]'); // PHP ['done'] is a list -> JSON array
    const gone = await db.selectFrom('os_opolo_cost').select('id').where('id', '=', id).executeTakeFirst();
    expect(gone).toBeUndefined();
    await app.close();
  });

  it('/opolo CSV upload inserts unseen order + detail rows (temp rows).', async () => {
    const admin = await userWithRole(['admin']);
    const orderId = `t16test2-${TS}`;
    const app = buildApp(admin);
    const boundary = '----t16boundary';
    const csv = [
      'Date,orderId,Name,Addr1,Addr2,City,State,Zip,Country,Name2,Qty,Asin,ItemId',
      `2024-01-01,${orderId},Test User,1 St,2nd,City,ST,12345,US,Prod Name,2,ASIN-T16,`,
    ].join('\n');
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="ordersfile"; filename="orders.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const out = await app.inject({
      method: 'POST',
      url: '/opolo',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/opolo.index');
    const order = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', orderId).executeTakeFirst();
    expect(order).not.toBeNull();
    expect(order?.recipientName).toBe('Test User');
    expect(order?.zip).toBe('12345');
    const detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', orderId).executeTakeFirst();
    expect(detail).not.toBeNull();
    expect(detail?.asin).toBe('ASIN-T16');
    expect(detail?.qty).toBe(2);
    // cleanup
    await db.deleteFrom('os_grant_order').where('orderId', '=', orderId).execute();
    await db.deleteFrom('os_grant_orderdetail').where('orderId', '=', orderId).execute();
    await app.close();
  });
});
