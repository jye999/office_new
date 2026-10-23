// T19: FollowUpsController (routes/web.php:231-239, role:admin,user,remote).
// Mutating routes are exercised with a temporary os_follow_ups row that is
// cleaned up at the end (T13/T17 pattern). updateTracking never calls any
// external tracking API — it only writes the row's `tracking` column.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerFollowUpsRoutes } from '../src/modules/followups/routes.js';
import { disk } from '../src/storage.js';
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
  registerFollowUpsRoutes(app);
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

async function deleteFollowup(id: number): Promise<void> {
  await db.deleteFrom('os_follow_ups').where('id', '=', id).execute();
}

describe('T19 followups (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/FollowUps' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      const res = await app.inject({ method: 'GET', url: '/FollowUps' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
      await app.close();
    }
  });

  it('GET /FollowUps renders the table; /create and /:id/edit render the old broken one-line views', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const idx = await app.inject({ method: 'GET', url: '/FollowUps' });
    expect(idx.statusCode).toBe(200);
    expect(idx.body).toContain('Create New');
    expect(idx.body).toContain('id="followups"');
    // Inline JS posts to the (absolute) named-route URLs.
    expect(idx.body).toMatch(/url : '.*\/FollowUps\.store'/);
    expect(idx.body).toMatch(/url : '.*\/FollowUps\.updateTracking'/);

    const create = await app.inject({ method: 'GET', url: '/FollowUps/create' });
    expect(create.statusCode).toBe(200);
    expect(create.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/FollowUps/create.blade.php');

    const edit = await app.inject({ method: 'GET', url: '/FollowUps/1/edit' });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/FollowUps/edit.blade.php');
    await app.close();
  });

  it('/FollowUps.ajax returns the 50 newest rows (all, no done filter) as JSON', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    const out = await app.inject({ method: 'GET', url: '/FollowUps.ajax' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(50);
    const direct = (await sql`select id from os_follow_ups order by id desc limit 50`.execute(db)) as { rows: { id: number }[] };
    expect(body.map((r) => r.id)).toEqual(direct.rows.map((r) => r.id));
    await app.close();
  });

  it('/FollowUps.show?id= returns the row JSON; missing id -> 404', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const direct = (await sql`select id from os_follow_ups order by id desc limit 1`.execute(db) as { rows: { id: number }[] }).rows[0]!;
    const out = await app.inject({ method: 'GET', url: `/FollowUps.show?id=${direct.id}` });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>;
    expect(body.id).toBe(direct.id);
    expect(body).toHaveProperty('orderId');
    expect(body).toHaveProperty('images');
    expect(body).toHaveProperty('tracking');

    const missing = await app.inject({ method: 'GET', url: '/FollowUps.show' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('/FollowUps.findOrder: unknown orderId -> empty 200; known orderId -> order + detail + tracking', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const none = await app.inject({ method: 'GET', url: '/FollowUps.findOrder?orderId=t19-no-such-order' });
    expect(none.statusCode).toBe(200);
    expect(none.body).toBe('');

    const order = (await sql`select orderId from os_grant_order order by id desc limit 1`.execute(db) as { rows: { orderId: string }[] }).rows[0]!;
    const out = await app.inject({ method: 'GET', url: `/FollowUps.findOrder?orderId=${order.orderId}` });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>;
    expect(body.orderId).toBe(order.orderId);
    expect(Array.isArray(body.detail)).toBe(true);
    expect(Array.isArray(body.tracking)).toBe(true);
    // Relation keys come after the scalar columns (Eloquent load order).
    const keys = Object.keys(body);
    expect(keys.indexOf('detail')).toBeGreaterThan(keys.indexOf('externalId'));
    expect(keys.indexOf('tracking')).toBe(keys.length - 1);
    await app.close();
  });

  it('store/update/updateTracking/destroy lifecycle on a temp row', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    const fu = disk('follow_up');
    let id: number | null = null;

    try {
      // store: no orderId -> plain-text 'failed' (200).
      const failed = await app.inject({
        method: 'POST',
        url: '/FollowUps.store',
        payload: { followup_date: '2024-01-02' },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.body).toBe('failed');

      // store: orderId present, done unset -> row created with done 0, images ''.
      const created = await app.inject({
        method: 'POST',
        url: '/FollowUps.store',
        payload: { orderId: 't19-store-test', notes: 'n1' },
      });
      expect(created.statusCode).toBe(200);
      const row = JSON.parse(created.body) as Record<string, unknown>;
      id = Number(row.id);
      expect(row.orderId).toBe('t19-store-test');
      expect(row.done).toBe(0);
      expect(row.images).toBe('');

      // update: null-ish fields dropped; notes + done written.
      const updated = await app.inject({
        method: 'PUT',
        url: '/FollowUps.update',
        payload: { id, notes: 'n2', cs_user: '', done: 2 },
      });
      expect(updated.statusCode).toBe(200);
      const updatedRow = JSON.parse(updated.body) as Record<string, unknown>;
      expect(updatedRow.notes).toBe('n2');
      expect(updatedRow.cs_user).toBe(null); // '' dropped by the == null quirk
      expect(updatedRow.done).toBe(2);

      // updateTracking: row tracking written, JSON "ok".
      const tracked = await app.inject({
        method: 'POST',
        url: '/FollowUps.updateTracking',
        payload: { id, tracking: 't19-track-123' },
      });
      expect(tracked.statusCode).toBe(200);
      expect(tracked.body).toBe('"ok"');

      // updateFollowUp: keeps existing images, writes only fillable fields.
      const upd = await app.inject({
        method: 'PUT',
        url: '/FollowUps.updateFollowUp',
        payload: { id, notes: 'n3' },
      });
      expect(upd.statusCode).toBe(200);
      expect((JSON.parse(upd.body) as Record<string, unknown>).notes).toBe('n3');

      // destroy: deletes the row, JSON "deleted".
      const destroyed = await app.inject({ method: 'DELETE', url: '/FollowUps.destroy', payload: { id } });
      expect(destroyed.statusCode).toBe(200);
      expect(destroyed.body).toBe('"deleted"');
      const gone = (await sql`select count(*) as c from os_follow_ups where id = ${id}`.execute(db) as { rows: { c: number }[] });
      expect(Number(gone.rows[0].c)).toBe(0);
      id = null;
    } finally {
      if (id) await deleteFollowup(id);
      void fu;
    }
    await app.close();
  });

  it('store with a multipart image upload: file stored on the follow_up disk, destroy removes it', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    const fu = disk('follow_up');
    let id: number | null = null;

    try {
      const boundary = 't19boundary';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="orderId"',
        '',
        't19-upload-test',
        `--${boundary}`,
        'Content-Disposition: form-data; name="images[]"; filename="pic.png"',
        'Content-Type: image/png',
        '',
        PNG.toString('binary'),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const out = await app.inject({
        method: 'POST',
        url: '/FollowUps.store',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(body, 'binary'),
      });
      expect(out.statusCode).toBe(200);
      const row = JSON.parse(out.body) as Record<string, unknown>;
      id = Number(row.id);
      expect(row.images).toBe(`${id}_0.png|||`);
      expect(await fu.exists(`${id}_0.png`)).toBe(true);

      // destroy() must remove the uploaded image file as well as the row.
      const destroyed = await app.inject({ method: 'DELETE', url: '/FollowUps.destroy', payload: { id } });
      expect(destroyed.body).toBe('"deleted"');
      expect(await fu.exists(`${id}_0.png`)).toBe(false);
      id = null;
    } finally {
      if (id) {
        await deleteFollowup(id);
        await fu.delete(`${id}_0.png`).catch(() => undefined);
      }
    }
    await app.close();
  });
});
