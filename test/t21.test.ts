// T21: BulkProductionController (routes/web.php:241-248, role:admin,user,remote).
// Mutating routes are exercised with a temporary os_bulk_productions row +
// uploaded images on the bulk_production disk, cleaned up at the end.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { disk } from '../src/storage.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerBulkProductionRoutes } from '../src/modules/bulkproduction/routes.js';
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
  registerBulkProductionRoutes(app);
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

describe('T21 bulkproduction (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/BulkProduction' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      for (const u of ['/BulkProduction', '/BulkProduction.show', '/BulkProduction.ajax']) {
        const res = await app.inject({ method: 'GET', url: u });
        expect(res.statusCode).toBe(403);
        expect(res.body).toBe('No Access.');
      }
      await app.close();
    }
  });

  it('GET /BulkProduction renders; create/edit render the old broken one-line views; updateFollowUp 500s', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const idx = await app.inject({ method: 'GET', url: '/BulkProduction' });
    expect(idx.statusCode).toBe(200);
    expect(idx.body).toContain('id="bulkProductions"');
    expect(idx.body).toMatch(/url : '.*\/BulkProduction\.store'/);
    expect(idx.body).toMatch(/url: '.*\/BulkProduction\.updateImages'/);

    const create = await app.inject({ method: 'GET', url: '/BulkProduction/create' });
    expect(create.statusCode).toBe(200);
    expect(create.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/BulkProduction/create.blade.php');

    const edit = await app.inject({ method: 'GET', url: '/BulkProduction/1/edit' });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toBe('/Users/jye/OneDrive/Documents/code/orders/app/views/BulkProduction/edit.blade.php');

    // view renders even when the row does not exist (find(), nullable).
    const editMissing = await app.inject({ method: 'GET', url: '/BulkProduction/99999/edit' });
    expect(editMissing.statusCode).toBe(200);

    // /BulkProduction.updateFollowUp: no such controller method -> 500 in the old app.
    const uf = await app.inject({ method: 'GET', url: '/BulkProduction.updateFollowUp' });
    expect(uf.statusCode).toBe(500);
    await app.close();
  });

  it('/BulkProduction.ajax returns the 50 newest rows as JSON; /BulkProduction.show -> row JSON / 404', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const out = await app.inject({ method: 'GET', url: '/BulkProduction.ajax' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as Record<string, unknown>[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(50);
    const direct = (await sql`select id from os_bulk_productions order by id desc limit 50`.execute(db)) as {
      rows: { id: number }[];
    };
    expect(body.map((r) => r.id)).toEqual(direct.rows.map((r) => r.id));

    // show: ?id= fallback (no route param) and the resource param.
    const top = body[0];
    const byQuery = await app.inject({ method: 'GET', url: `/BulkProduction.show?id=${top.id}` });
    expect(byQuery.statusCode).toBe(200);
    expect((JSON.parse(byQuery.body) as Record<string, unknown>).id).toBe(top.id);

    const byParam = await app.inject({ method: 'GET', url: `/BulkProduction/${top.id}` });
    expect(byParam.statusCode).toBe(200);
    expect((JSON.parse(byParam.body) as Record<string, unknown>).id).toBe(top.id);

    // no id -> findOrFail(null) -> 404; missing row -> 404.
    const none = await app.inject({ method: 'GET', url: '/BulkProduction.show' });
    expect(none.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/BulkProduction/99999' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('store -> update -> updateImages -> destroy lifecycle (temp row + disk images cleaned up)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    const pd = disk('bulk_production');
    const boundary = 't21boundary';

    // No files: row created with images='' and null eta/notes when absent.
    const plain = await app.inject({
      method: 'POST',
      url: '/BulkProduction.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'eta=2026-02-01&notes=t21-temp-notes',
    });
    expect(plain.statusCode).toBe(200);
    let created = JSON.parse(plain.body) as Record<string, unknown>;
    expect(created.notes).toBe('t21-temp-notes');
    expect(created.images).toBe('');
    const id = Number(created.id);

    // Multipart body must be a Buffer (string payloads get UTF-8-encoded, corrupting the PNG).
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="eta"',
      '',
      '2026-03-01',
      `--${boundary}`,
      'Content-Disposition: form-data; name="notes"',
      '',
      't21-temp-production',
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
      url: '/BulkProduction.store',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(body, 'binary'),
    });
    expect(ok.statusCode).toBe(200);
    created = JSON.parse(ok.body) as Record<string, unknown>;
    expect(created.notes).toBe('t21-temp-production');
    const id2 = Number(created.id);
    expect(created.images).toBe(`${id2}_0.png|||`);
    expect(await pd.exists(`${id2}_0.png`)).toBe(true);

    let secondCreatedId: number | null = id2;
    try {
      // store() re-encodes (sharp); updateImages() writes RAW bytes.
      const up = await app.inject({
        method: 'POST',
        url: `/BulkProduction.update?id=${id2}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'eta=&notes=',
      });
      expect(up.statusCode).toBe(200);
      // PHP == null: eta='' and notes='' are dropped -> column values unchanged.
      expect((JSON.parse(up.body) as Record<string, unknown>).notes).toBe('t21-temp-production');
      expect((JSON.parse(up.body) as Record<string, unknown>).eta).toBe('2026-03-01');

      // updateImages with a file: deletes the existing image, appends the raw upload.
      const ub = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="id"',
        '',
        String(id2),
        `--${boundary}`,
        'Content-Disposition: form-data; name="images[]"; filename="b.png"',
        'Content-Type: image/png',
        '',
        PNG.toString('binary'),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const ui = await app.inject({
        method: 'POST',
        url: '/BulkProduction.updateImages',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(ub, 'binary'),
      });
      expect(ui.statusCode).toBe(200);
      const after = JSON.parse(ui.body) as Record<string, unknown>;
      expect(after.images).toBe(`${id2}_0.png|||`);
      expect(await pd.exists(`${id2}_0.png`)).toBe(true);

      // updateImages without a file: images unchanged, eta/notes from fields.
      const ui2 = await app.inject({
        method: 'POST',
        url: `/BulkProduction.updateImages?id=${id2}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'notes=t21-after-images',
      });
      expect(ui2.statusCode).toBe(200);
      const after2 = JSON.parse(ui2.body) as Record<string, unknown>;
      expect(after2.images).toBe(`${id2}_0.png|||`);
      expect(after2.notes).toBe('t21-after-images');
    } finally {
      // destroy via the resource param deletes the row and its disk images.
      const del = await app.inject({ method: 'DELETE', url: `/BulkProduction/${id2}` });
      expect(del.statusCode).toBe(200);
      expect(del.body).toBe('"deleted"');
      expect(await db.selectFrom('os_bulk_productions').selectAll().where('id', '=', id2).executeTakeFirst()).toBeUndefined();
      expect(await pd.exists(`${id2}_0.png`)).toBe(false);
      secondCreatedId = null;

      // destroy via ?id= (no route param).
      const del2 = await app.inject({ method: 'DELETE', url: `/BulkProduction.destroy?id=${id}` });
      expect(del2.statusCode).toBe(200);
      expect(del2.body).toBe('"deleted"');
      expect(await db.selectFrom('os_bulk_productions').selectAll().where('id', '=', id).executeTakeFirst()).toBeUndefined();
    }
    expect(secondCreatedId).toBeNull();
    await app.close();
  });

  it('bare PUT /BulkProduction (optional resource param) updates via ?id=', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    const plain = await app.inject({
      method: 'POST',
      url: '/BulkProduction.store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'notes=t21-bare',
    });
    const id = Number((JSON.parse(plain.body) as Record<string, unknown>).id);
    try {
      const up = await app.inject({
        method: 'PUT',
        url: `/BulkProduction?id=${id}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'eta=2026-04-01',
      });
      expect(up.statusCode).toBe(200);
      expect((JSON.parse(up.body) as Record<string, unknown>).eta).toBe('2026-04-01');
    } finally {
      const del = await app.inject({ method: 'DELETE', url: `/BulkProduction.destroy?id=${id}` });
      expect(del.statusCode).toBe(200);
    }
    await app.close();
  });
});
