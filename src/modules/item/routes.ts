// ItemController (routes/web.php:305-309, role:admin,user,remote).
//
// Quirks kept (plan/NOTES.md), verified live on the old app:
// - os_items / os_itemimages do not exist in the shared DB, so every
//   DB-touching route 500s (query throws -> the app's 500 view; sendServer500).
//   Raw SQL is used for these tables because they are absent from the
//   generated Kysely types (T15 pattern).
// - /item/create 500s even without the DB: the view calls the Laravel-4-only
//   Session::getToken() (fatal "Call to undefined method"), so the handler
//   500s before rendering. views/item/create.njk is ported but never reached
//   (its getToken line is written as csrf_token(); dead either way).
// - /upload.item.image validates $request->all(), which EXCLUDES multipart
//   files, so the 'image|max:3000' rules are always skipped; a missing file
//   part then 500s on null->getClientOriginalExtension(). Files land in
//   <public>/uploads/<rand(11111,99999)>.<ext> (old app CWD is public/).

import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { nowDb, officePool } from '../../db.js';
import { allInput, input, lredirect } from '../../http.js';
import { image } from '../../images.js';
import { btDeleting } from '../../lib/ajaxis.js';
import { resource, route } from '../../router.js';
import { paginateHtml, render, sendServer500, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
const PER_PAGE = 6;

type Row = Record<string, unknown>;

// Raw-SQL query helper (os_items is not in the generated Kysely types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function q(sql: string, params: unknown[] = []): Promise<any> {
  const r = await officePool.query(sql, params);
  return Array.isArray(r) ? r[0] : r;
}

// The resource registers the param as `{item}`; the extra routes use `{id}`.
function paramId(req: FastifyRequest): number {
  const p = req.params as Record<string, string>;
  return Number(p.id ?? p['item']);
}

function isAjax(req: FastifyRequest): boolean {
  return req.headers['x-requested-with'] === 'XMLHttpRequest';
}

// Item::findOrFail($id) -> 404 when missing (surfaced by the router's not-found).
async function findItem(id: number): Promise<Row> {
  const rows = (await q('select * from os_items where id = ?', [id])) as Row[];
  if (!rows[0]) throw Object.assign(new Error('Item not found'), { statusCode: 404 });
  return rows[0];
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

async function itemIndex(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const total = Number(((await q('select count(*) as total from os_items')) as Row[])[0].total);
    const page = pageFrom(req);
    const items = (await q('select * from os_items limit ? offset ?', [PER_PAGE, (page - 1) * PER_PAGE])) as Row[];
    await render(req, reply, 'item/index', {
      items,
      itemsRender: paginateHtml(total, PER_PAGE, page, baseWithoutPage(req)),
    });
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) throw e;
    await sendServer500(req, reply);
  }
}

// store(): insert (+dup-SKU Log::info, no side effect), then for each images[]
// entry: rename <public>/uploads/<n> -> images/catalog/<id>_<i>.jpg, save a
// 300px-wide copy as _small.jpg, insert an os_itemimages row. No timestamps
// on Itemimage ($timestamps = false).
async function itemStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ins = (await q(
    'insert into os_items (SKU, Name, Description, Cost, Qty, created_at, updated_at) values (?,?,?,?,?,?,?)',
    [
      input(req, 'SKU'),
      input(req, 'Name'),
      input(req, 'Description'),
      input(req, 'Cost'),
      input(req, 'Qty'),
      nowDb(),
      nowDb(),
    ],
  )) as { insertId: number };
  const id = Number(ins.insertId);
  const images = input(req, 'images') as string[] | string | null;
  const list = Array.isArray(images) ? images : images === null ? [] : [images];
  let counter = 0;
  for (const img of list) {
    const imageName = `${id}_${counter}.jpg`;
    const smallImageName = `${id}_${counter}_small.jpg`;
    const catalog = `${config.PUBLIC_DIR}/images/catalog`;
    await fs.rename(`${config.PUBLIC_DIR}/uploads/${img}`, `${catalog}/${imageName}`);
    // Image::make(...)->resize(300, null, aspectRatio): scale to 300 wide,
    // height proportional (upscaling allowed, unlike widen()).
    const small = await image(`${catalog}/${imageName}`).resize(300, null).stream();
    await fs.writeFile(`${catalog}/${smallImageName}`, small);
    await q('insert into os_itemimages (itemId, path, isPrimary) values (?,?,0)', [id, imageName]);
    counter++;
  }
  lredirect(req, reply, url('item'));
}

async function itemShow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  if (isAjax(req)) return reply.type('text/html; charset=UTF-8').send(url(`item/${id}`));
  const item = await findItem(id);
  const images = (await q('select * from os_itemimages where itemId = ?', [id])) as Row[];
  await render(req, reply, 'item/show', { item: { ...item, images } });
}

async function itemEdit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  if (isAjax(req)) return reply.type('text/html; charset=UTF-8').send(url(`item/${id}/edit`));
  const item = await findItem(id);
  await render(req, reply, 'item/edit', { item });
}

// POST /item/{id}/update (web.php:306; the resource's PUT/PATCH update is the
// same controller method).
async function itemUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  await findItem(id);
  await q('update os_items set SKU = ?, Name = ?, Description = ?, Cost = ?, Qty = ?, updated_at = ? where id = ?', [
    input(req, 'SKU'),
    input(req, 'Name'),
    input(req, 'Description'),
    input(req, 'Cost'),
    input(req, 'Qty'),
    nowDb(),
    id,
  ]);
  lredirect(req, reply, url('item'));
}

// GET /item/{id}/delete: delete then return URL::to('item') as a plain body.
async function itemDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  await findItem(id);
  await q('delete from os_items where id = ?', [id]);
  reply.type('text/html; charset=UTF-8').send(url('item'));
}

// GET /item/{id}/deleteMsg: Ajaxis modal for ajax requests; non-ajax returns
// null (empty 200 body).
async function itemDeleteMsg(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = String(paramId(req));
  const msg = btDeleting('Warning!!', 'Would you like to remove This?', `/item/${id}/delete`);
  if (isAjax(req)) reply.type('text/html; charset=UTF-8').send(msg);
}

// POST /upload.item.image: see the file-top quirk notes.
async function uploadImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Validator::make($request->all(), ...): files are not in all(), so the
  // rules only fire when a plain 'file' form/query field is present (and it is
  // never a valid image) -> always the first rule's message.
  if (allInput(req).file !== undefined) {
    return reply.code(400).type('text/html; charset=UTF-8').send('The file must be an image.');
  }
  // Drain every part (breaking early leaves the multipart stream open ->
  // premature close); only the 'file' part is used.
  let file: { fieldname: string; filename: string; toBuffer: () => Promise<Buffer> } | null = null;
  for await (const part of req.files()) {
    const p = part as { fieldname: string; filename: string; toBuffer: () => Promise<Buffer> };
    if (p.fieldname === 'file' && !file) file = p;
    else await p.toBuffer().catch(() => undefined);
  }
  if (!file) {
    // null->getClientOriginalExtension() fatal in the old app.
    await sendServer500(req, reply);
    return;
  }
  // getClientOriginalExtension(): Symfony guessClientExtension = last-dot part.
  const name = file.filename;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  // PHP rand(11111, 99999).
  const fileName = `${Math.floor(Math.random() * (99999 - 11111 + 1)) + 11111}.${ext}`;
  const dir = `${config.PUBLIC_DIR}/uploads`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/${fileName}`, await file.toBuffer());
  reply.type('application/json; charset=utf-8').send(JSON.stringify(fileName));
}

export function registerItemRoutes(app: FastifyInstance): void {
  // Route::resource('item', ...)
  resource(app, '/item', {
    index: itemIndex,
    create: async (_req, reply) => sendServer500(_req, reply), // view fatal: Session::getToken()
    store: itemStore,
    show: itemShow,
    edit: itemEdit,
    update: itemUpdate,
    destroy: itemDestroy,
  }, { roles: ROLES });
  route(app, { verb: 'post', path: '/item/{id}/update', roles: ROLES, handler: itemUpdate });
  route(app, { verb: 'get', path: '/item/{id}/delete', roles: ROLES, handler: itemDestroy });
  route(app, { verb: 'get', path: '/item/{id}/deleteMsg', roles: ROLES, handler: itemDeleteMsg });
  route(app, { verb: 'post', path: '/upload.item.image', roles: ROLES, handler: uploadImage });
}
