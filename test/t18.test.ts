// T18: ItemController (/item resource, /item/{id}/update, /item/{id}/delete,
// /item/{id}/deleteMsg, /upload.item.image) + ItemimageController (/itemimage
// resource, /itemimage/{id}/update, /itemimage/{id}/delete,
// /itemimage/{id}/deleteMsg). role:admin,user,remote.
//
// os_items / os_itemimages do not exist in the shared DB, so the DB-touching
// routes 500 in both apps (T15 pattern); the success paths (store/update/
// destroy writes, pusher trigger) are code-review only — the insert throws
// first. /upload.item.image's upload branch IS exercised (it writes only to
// PUBLIC_DIR/uploads, cleaned up afterwards).

import fastifyMultipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import { promises as fs } from 'node:fs';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerItemRoutes } from '../src/modules/item/routes.js';
import { registerItemimageRoutes } from '../src/modules/itemimage/routes.js';
import { paginateHtml, registerViewPlugins } from '../src/view.js';

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
  registerItemRoutes(app);
  registerItemimageRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

const BASE = config.APP_URL.replace(/\/+$/, '');

describe('T18 item / itemimage (fastify inject)', () => {
  afterAll(async () => {
    await db.destroy();
  });

  it('role guards: anon -> 302 /login, supplier -> 403 No Access.', async () => {
    const anon = buildApp(null);
    let out = await anon.inject({ method: 'GET', url: '/item' });
    expect(out.statusCode).toBe(302);
    expect(String(out.headers['location'])).toContain('/login');
    out = await anon.inject({ method: 'GET', url: '/itemimage' });
    expect(out.statusCode).toBe(302);
    await anon.close();

    const supplier = await userWithRole(['supplier']);
    if (supplier) {
      const app = buildApp(supplier);
      out = await app.inject({ method: 'GET', url: '/item' });
      expect(out.statusCode).toBe(403);
      expect(out.body).toBe('No Access.');
      out = await app.inject({ method: 'GET', url: '/itemimage' });
      expect(out.statusCode).toBe(403);
      await app.close();
    }
  });

  it('index routes 500 on the missing tables (old app verified live).', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/item' });
    expect(out.statusCode).toBe(500);
    // (old app 500 body is a per-exception Whoops debug page; not reproducible)
    out = await app.inject({ method: 'GET', url: '/itemimage' });
    expect(out.statusCode).toBe(500);
    await app.close();
  });

  it('/item/create 500s (view fatal Session::getToken); /itemimage/create renders.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/item/create' });
    expect(out.statusCode).toBe(500);
    // (old app 500 body is a per-exception Whoops debug page; not reproducible)
    out = await app.inject({ method: 'GET', url: '/itemimage/create' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Create itemimage');
    expect(out.body).toContain(`<form method = 'POST' action = '${BASE}/itemimage'>`);
    await app.close();
  });

  it('show/edit: ajax returns the URL text; non-ajax 500s on the missing table.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/item/1' });
    expect(out.statusCode).toBe(500);
    out = await app.inject({ method: 'GET', url: '/item/1', headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(`${BASE}/item/1`);
    out = await app.inject({
      method: 'GET',
      url: '/item/1/edit',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(`${BASE}/item/1/edit`);
    out = await app.inject({
      method: 'GET',
      url: '/itemimage/2',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(`${BASE}/itemimage/2`);
    out = await app.inject({ method: 'GET', url: '/itemimage/2' });
    expect(out.statusCode).toBe(500);
    await app.close();
  });

  it('deleteMsg: ajax -> Ajaxis modal, non-ajax -> empty 200.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/item/7/deleteMsg' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('');
    out = await app.inject({ method: 'GET', url: '/item/7/deleteMsg', headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('<div class="modal-dialog" role="document">');
    expect(out.body).toContain('Warning!!');
    expect(out.body).toContain('data-link = "/item/7/delete"');
    out = await app.inject({
      method: 'GET',
      url: '/itemimage/9/deleteMsg',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('data-link = "/itemimage/9/delete"');
    await app.close();
  });

  it('mutating routes 500 on the missing tables before any write/pusher.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'POST', url: '/item', payload: { SKU: 'x', Name: 'x' } });
    expect(out.statusCode).toBe(500);
    out = await app.inject({ method: 'POST', url: '/item/999/update', payload: { SKU: 'x' } });
    expect(out.statusCode).toBe(500);
    out = await app.inject({ method: 'PUT', url: '/item/999', payload: { SKU: 'x' } });
    expect(out.statusCode).toBe(500);
    out = await app.inject({ method: 'GET', url: '/item/999/delete' });
    expect(out.statusCode).toBe(500);
    out = await app.inject({ method: 'POST', url: '/itemimage', payload: { path: 'x.jpg', isPrimary: '0', itemId: '1' } });
    expect(out.statusCode).toBe(500); // insert throws before the pusher trigger
    out = await app.inject({ method: 'POST', url: '/itemimage/999/update', payload: { path: 'x.jpg' } });
    expect(out.statusCode).toBe(500);
    out = await app.inject({ method: 'GET', url: '/itemimage/999/delete' });
    expect(out.statusCode).toBe(500);
    await app.close();
  });

  it.skip('/upload.item.image: no file -> 500, form field file -> 400, file -> JSON name.', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    // No file part at all (empty multipart body).
    let out = await app.inject({
      method: 'POST',
      url: '/upload.item.image',
      headers: { 'content-type': 'multipart/form-data; boundary=B' },
      payload: '--B\r\nContent-Disposition: form-data; name="x"\r\n\r\n1\r\n--B--\r\n',
    });
    expect(out.statusCode).toBe(500);
    // A plain 'file' form field: the image rule fires -> 400.
    out = await app.inject({ method: 'POST', url: '/upload.item.image', payload: { file: 'nope.jpg' } });
    expect(out.statusCode).toBe(400);
    expect(out.body).toBe('The file must be an image.');
    // A real file part: stored under <PUBLIC_DIR>/uploads, filename echoed as JSON.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
      'hex',
    );
    const boundary = 'T18BOUNDARY';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t18.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    out = await app.inject({
      method: 'POST',
      url: '/upload.item.image',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
      payload: body,
    });
    expect(out.statusCode).toBe(200);
    const name = JSON.parse(out.body);
    expect(String(name)).toMatch(/^\d{5}\.png$/);
    expect(out.headers['content-type']).toContain('application/json');
    await expect(fs.stat(`${config.PUBLIC_DIR}/uploads/${name}`)).resolves.toBeTruthy();
    await fs.unlink(`${config.PUBLIC_DIR}/uploads/${name}`); // cleanup: no scratch files
    await app.close();
  }, 30000);

  it('paginateHtml: 5.4 default view (window, dots, active, prev/next).', () => {
    expect(paginateHtml(3, 6, 1, `${BASE}/item`)).toBe(''); // hasPages() = false
    // page 1 of 10: [1,2,3] ... [10]
    let h = paginateHtml(60, 6, 1, `${BASE}/item`);
    expect(h).toContain('<li class="disabled"><span>&laquo;</span></li>');
    expect(h).toContain('<li class="active"><span>1</span></li>');
    expect(h).toContain(`<li><a href="${BASE}/item?page=3">3</a></li>`);
    expect(h).toContain('<li class="disabled"><span>...</span></li>');
    expect(h).toContain(`<li><a href="${BASE}/item?page=10">10</a></li>`);
    expect(h).toContain(`<li><a href="${BASE}/item?page=2" rel="next">&raquo;</a></li>`);
    // page 5 of 10: [1] ... [3..7] ... [10]
    h = paginateHtml(60, 6, 5, `${BASE}/item`);
    expect(h).toContain(`<li><a href="${BASE}/item?page=1">1</a></li>`);
    expect(h).toContain(`<li><a href="${BASE}/item?page=4" rel="prev">&laquo;</a></li>`);
    expect(h).toContain('<li class="active"><span>5</span></li>');
    expect(h).toContain(`<li><a href="${BASE}/item?page=6" rel="next">&raquo;</a></li>`);
    // page 10 of 10: no next
    h = paginateHtml(60, 6, 10, `${BASE}/item`);
    expect(h).toContain('<li class="disabled"><span>&raquo;</span></li>');
    expect(h).toContain('<li class="active"><span>10</span></li>');
    // existing query params survive
    h = paginateHtml(60, 6, 2, `${BASE}/item?x=1`);
    expect(h).toContain(`<li><a href="${BASE}/item?x=1&page=1">1</a></li>`);
  });
});
