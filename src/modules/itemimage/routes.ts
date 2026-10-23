// ItemimageController (routes/web.php:312-315, role:admin,user,remote).
//
// Quirks kept (plan/NOTES.md), verified live on the old app:
// - os_itemimages does not exist in the shared DB, so every DB-touching route
//   500s (query throws -> the app's 500 view; sendServer500). Raw SQL is used
//   because the table is absent from the generated Kysely types (T15 pattern).
// - Itemimage has $timestamps = false, so inserts/updates never touch
//   created_at/updated_at.
// - store() triggers a real Pusher 'test-channel'/'test-event' after the
//   insert (scaffold boilerplate); the insert throws first while the table is
//   missing, so no pusher call happens.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { officePool } from '../../db.js';
import { input, lredirect } from '../../http.js';
import { trigger } from '../../pusher.js';
import { btDeleting } from '../../lib/ajaxis.js';
import { resource, route } from '../../router.js';
import { paginateHtml, render, sendServer500, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
const PER_PAGE = 6;

type Row = Record<string, unknown>;

// Raw-SQL query helper (os_itemimages is not in the generated Kysely types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function q(sql: string, params: unknown[] = []): Promise<any> {
  const r = await officePool.query(sql, params);
  return Array.isArray(r) ? r[0] : r;
}

// The resource registers the param as `{itemimage}`; the extra routes use `{id}`.
function paramId(req: FastifyRequest): number {
  const p = req.params as Record<string, string>;
  return Number(p.id ?? p['itemimage']);
}

function isAjax(req: FastifyRequest): boolean {
  return req.headers['x-requested-with'] === 'XMLHttpRequest';
}

// Itemimage::findOrFail($id) -> 404 when missing (surfaced by the router's not-found).
async function findItemimage(id: number): Promise<void> {
  const rows = (await q('select * from os_itemimages where id = ?', [id])) as Row[];
  if (!rows[0]) throw Object.assign(new Error('Itemimage not found'), { statusCode: 404 });
}

function pageFrom(req: FastifyRequest): number {
  return Math.max(1, Number(input(req, 'page')) || 1);
}

function baseWithoutPage(req: FastifyRequest): string {
  const raw = req.raw.url ?? '';
  const q = raw
    .split('?')[1]
    ?.split('&')
    .filter((kv) => kv && !kv.startsWith('page='))
    .join('&');
  return url(raw.split('?')[0], q ? Object.fromEntries(q.split('&').map((kv) => kv.split('='))) : undefined);
}

async function itemimageIndex(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const total = Number(((await q('select count(*) as total from os_itemimages')) as Row[])[0].total);
    const page = pageFrom(req);
    const itemimages = (await q('select * from os_itemimages limit ? offset ?', [PER_PAGE, (page - 1) * PER_PAGE])) as Row[];
    await render(req, reply, 'itemimage/index', {
      itemimages,
      itemimagesRender: paginateHtml(total, PER_PAGE, page, baseWithoutPage(req)),
    });
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) throw e;
    await sendServer500(req, reply);
  }
}

// store(): insert (no timestamps), pusher test-channel/test-event, redirect.
async function itemimageStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await q('insert into os_itemimages (path, isPrimary, itemId) values (?,?,?)', [
    input(req, 'path'),
    input(req, 'isPrimary'),
    input(req, 'itemId'),
  ]);
  await trigger('test-channel', 'test-event', { message: 'A new itemimage has been created !!' });
  lredirect(req, reply, url('itemimage'));
}

async function itemimageShow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  if (isAjax(req)) return reply.type('text/html; charset=UTF-8').send(url(`itemimage/${id}`));
  const rows = (await q('select * from os_itemimages where id = ?', [id])) as Row[];
  if (!rows[0]) throw Object.assign(new Error('Itemimage not found'), { statusCode: 404 });
  await render(req, reply, 'itemimage/show', { itemimage: rows[0] });
}

async function itemimageEdit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  if (isAjax(req)) return reply.type('text/html; charset=UTF-8').send(url(`itemimage/${id}/edit`));
  const rows = (await q('select * from os_itemimages where id = ?', [id])) as Row[];
  if (!rows[0]) throw Object.assign(new Error('Itemimage not found'), { statusCode: 404 });
  await render(req, reply, 'itemimage/edit', { itemimage: rows[0] });
}

// POST /itemimage/{id}/update (web.php:313; the resource's PUT/PATCH update is
// the same controller method).
async function itemimageUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  await findItemimage(id);
  await q('update os_itemimages set path = ?, isPrimary = ?, itemId = ? where id = ?', [
    input(req, 'path'),
    input(req, 'isPrimary'),
    input(req, 'itemId'),
    id,
  ]);
  lredirect(req, reply, url('itemimage'));
}

// GET /itemimage/{id}/delete: delete then return URL::to('itemimage') as a plain body.
async function itemimageDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  await findItemimage(id);
  await q('delete from os_itemimages where id = ?', [id]);
  reply.type('text/html; charset=UTF-8').send(url('itemimage'));
}

// GET /itemimage/{id}/deleteMsg: Ajaxis modal for ajax requests; non-ajax
// returns null (empty 200 body).
async function itemimageDeleteMsg(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = String(paramId(req));
  const msg = btDeleting('Warning!!', 'Would you like to remove This?', `/itemimage/${id}/delete`);
  if (isAjax(req)) reply.type('text/html; charset=UTF-8').send(msg);
}

export function registerItemimageRoutes(app: FastifyInstance): void {
  // Route::resource('itemimage', ...)
  resource(app, '/itemimage', {
    index: itemimageIndex,
    create: async (req, reply) => render(req, reply, 'itemimage/create'),
    store: itemimageStore,
    show: itemimageShow,
    edit: itemimageEdit,
    update: itemimageUpdate,
    destroy: itemimageDestroy,
  }, { roles: ROLES });
  route(app, { verb: 'post', path: '/itemimage/{id}/update', roles: ROLES, handler: itemimageUpdate });
  route(app, { verb: 'get', path: '/itemimage/{id}/delete', roles: ROLES, handler: itemimageDestroy });
  route(app, { verb: 'get', path: '/itemimage/{id}/deleteMsg', roles: ROLES, handler: itemimageDeleteMsg });
}
