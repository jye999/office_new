// T20: ProductionController + PurchaseController (routes/web.php:250-264,
// role:admin,user,remote). Mutating routes are exercised with temporary
// os_productions / os_purchases rows cleaned up at the end (T13/T17 pattern).

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerProductionRoutes } from '../src/modules/production/routes.js';
import { registerPurchaseRoutes } from '../src/modules/purchase/routes.js';
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
  registerProductionRoutes(app);
  registerPurchaseRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

// A tiny valid 1x1 PNG for the multipart upload tests.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('T20 production/purchase (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    for (const u of ['/Production', '/Purchase']) {
      const out = await anon.inject({ method: 'GET', url: u });
      expect(out.statusCode).toBe(302);
      expect(out.headers['location']).toBe('http://localhost:80/login');
    }
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      for (const u of ['/Production', '/Purchase']) {
        const res = await app.inject({ method: 'GET', url: u });
        expect(res.statusCode).toBe(403);
        expect(res.body).toBe('No Access.');
      }
      await app.close();
    }
  });

  it('GET /Production + /Purchase render; create/edit render the old broken one-line views; updateFollowUp 500s; purchase edit 500s', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const idx = await app.inject({ method: 'GET', url: '/Production' });
    expect(idx.statusCode).toBe(200);
    expect(idx.body).toContain('id="productions"');
    expect(idx.body).toMatch(/url : '.*\/Production\.store'/);

    const pidx = await app.inject({ method: 'GET', url: '/Purchase' });
    expect(pidx.statusCode).toBe(200);
    expect(pidx.body).toContain('id="purchases"');
    expect(pidx.body).toMatch(/url : '.*\/Purchase\.store'/);

    const create = await app.inject({ method: 'GET', url: '/Production/create' });
    expect(create.statusCode).toBe(200);
    expect(create.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/FollowUps/create.blade.php');
    const pcreate = await app.inject({ method: 'GET', url: '/Purchase/create' });
    expect(pcreate.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/FollowUps/create.blade.php');

    const edit = await app.inject({ method: 'GET', url: '/Production/16/edit' });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/FollowUps/edit.blade.php');

    // view('purchase.edit') does not exist in the old app -> 500.
    const pedit = await app.inject({ method: 'GET', url: '/Purchase/5/edit' });
    expect(pedit.statusCode).toBe(500);

    // /{Base}.updateFollowUp: no such controller method -> 500 in the old app.
    for (const u of ['/Production.updateFollowUp', '/Purchase.updateFollowUp']) {
      const r = await app.inject({ method: 'GET', url: u });
      expect(r.statusCode).toBe(500);
    }
    await app.close();
  });

  it('/Production.ajax + /Purchase.ajax return the 50 newest rows as JSON', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const out = await app.inject({ method: 'GET', url: '/Production.ajax' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(50);
    const direct = (await sql`select id from os_productions order by id desc limit 50`.execute(db)) as { rows: { id: number }[] };
    expect(body.map((r) => r.id)).toEqual(direct.rows.map((r) => r.id));

    const pout = await app.inject({ method: 'GET', url: '/Purchase.ajax' });
    const pbody = JSON.parse(pout.body) as Record<string, unknown>[];
    const pdirect = (await sql`select id from os_purchases order by id desc limit 50`.execute(db)) as { rows: { id: number }[] };
    expect(pbody.map((r) => r.id)).toEqual(pdirect.rows.map((r) => r.id));
    await app.close();
  });

  it('resource route param lands in $id positionally: /:id -> row JSON, /999 -> 404', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const row = (await sql`select id, name from os_productions order by id desc limit 1`.execute(db)) as { rows: { id: number; name: string }[] };
    const show = await app.inject({ method: 'GET', url: `/Production/${row.rows[0].id}` });
    expect(show.statusCode).toBe(200);
    expect((JSON.parse(show.body) as Record<string, unknown>).name).toBe(row.rows[0].name);

    const missing = await app.inject({ method: 'GET', url: '/Production/99999' });
    expect(missing.statusCode).toBe(404);

    const prow = (await sql`select id, name from os_purchases order by id desc limit 1`.execute(db)) as { rows: { id: number; name: string }[] };
    const pshow = await app.inject({ method: 'GET', url: `/Purchase/${prow.rows[0].id}` });
    expect(pshow.statusCode).toBe(200);
    expect((JSON.parse(pshow.body) as Record<string, unknown>).name).toBe(prow.rows[0].name);

    const pmissing = await app.inject({ method: 'GET', url: '/Purchase/99999' });
    expect(pmissing.statusCode).toBe(404);
    await app.close();
  });

  it('production store->update->destroy lifecycle (temp row + uploaded image cleaned up)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    // no name -> plain-text 'failed' (200), no row written.
    const bad = await app.inject({
      method: 'POST',
      url: '/Production.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'production_date=2026-01-01',
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toBe('failed');

    // Multipart body must be a Buffer (string payloads get UTF-8-encoded, corrupting the PNG).
    const boundary = 't20boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="name"',
      '',
      't20-temp-production',
      `--${boundary}`,
      'Content-Disposition: form-data; name="production_date"',
      '',
      '2026-01-01',
      `--${boundary}`,
      'Content-Disposition: form-data; name="assignTo"',
      '',
      'other',
      `--${boundary}`,
      'Content-Disposition: form-data; name="images[]"; filename="a.png"',
      'Content-Type: image/png',
      '',
      PNG.toString('binary'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const ok = await app.inject({
      method: 'POST',
      url: '/Production.store',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(body, 'binary'),
    });
    expect(ok.statusCode).toBe(200);
    const created = JSON.parse(ok.body) as Record<string, unknown>;
    expect(created.name).toBe('t20-temp-production');
    expect(created.images).toBe(`${created.id}_0.png|||`);
    const id = Number(created.id);
    try {
      // PUT /Production/:id (resource param) updates; finished_qty='0' is dropped (PHP == null).
      const up = await app.inject({
        method: 'PUT',
        url: `/Production/${id}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'notes=t20-temp-notes&finished_qty=0',
      });
      expect(up.statusCode).toBe(200);
      const updated = JSON.parse(up.body) as Record<string, unknown>;
      expect(updated.notes).toBe('t20-temp-notes');
      expect(updated.finished_qty).toBe(0); // '0' dropped -> column keeps its value
      // PUT /Production (bare path, optional resource param) via ?id=
      const bare = await app.inject({
        method: 'PUT',
        url: '/Production?id=' + id,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'assignTo=bouquet',
      });
      expect(bare.statusCode).toBe(200);
      expect((JSON.parse(bare.body) as Record<string, unknown>).assignTo).toBe('bouquet');
    } finally {
      const del = await app.inject({ method: 'DELETE', url: `/Production.destroy?id=${id}` });
      expect(del.statusCode).toBe(200);
      expect(del.body).toBe('"deleted"');
      const left = await db.selectFrom('os_productions').selectAll().where('id', '=', id).executeTakeFirst();
      expect(left).toBeUndefined();
    }
    await app.close();
  });

  it('purchase store->update->destroy lifecycle (temp row, no image, cleaned up)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    // missing qty -> 'failed'.
    const bad = await app.inject({
      method: 'POST',
      url: '/Purchase.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=t20-noqty',
    });
    expect(bad.body).toBe('failed');

    const ok = await app.inject({
      method: 'POST',
      url: '/Purchase.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=t20-temp-purchase&qty=7&sku=t20-sku&status=pending',
    });
    expect(ok.statusCode).toBe(200);
    const created = JSON.parse(ok.body) as Record<string, unknown>;
    expect(created.name).toBe('t20-temp-purchase');
    expect(created.qty).toBe(7);
    expect(created.images).toBe('');
    const id = Number(created.id);
    try {
      const up = await app.inject({
        method: 'PUT',
        url: '/Purchase.update?id=' + id,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'current_qty=3&status=OnRoute',
      });
      expect(up.statusCode).toBe(200);
      const updated = JSON.parse(up.body) as Record<string, unknown>;
      expect(updated.current_qty).toBe(3);
      expect(updated.status).toBe('OnRoute');
    } finally {
      const del = await app.inject({ method: 'DELETE', url: `/Purchase/${id}` });
      expect(del.body).toBe('"deleted"');
      const left = await db.selectFrom('os_purchases').selectAll().where('id', '=', id).executeTakeFirst();
      expect(left).toBeUndefined();
    }
    await app.close();
  });
});
