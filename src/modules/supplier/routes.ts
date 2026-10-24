// SupplierProductController (routes/web.php:91-104; all role:admin,user,supplier):
// the Vue SPA shell (also the `/{Supplier?}` catch-all fallback) + the JSON API
// the compiled bundle calls.
//
// Quirks kept (plan/NOTES.md):
// - store() assigns name/supplier unconditionally and stamps updated_at only
//   when something changed (Eloquent dirty check).
// - uploadMultipleImage() 500s when the request carries no `files` input
//   (sizeof(null) warning -> ErrorException in Laravel).
// - deleteImage() removes only the full-size file (the icon is orphaned).
// - createAllThumbnail() has no route; not ported.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from '../../auth.js';
import { db, nowDb, sql } from '../../db.js';
import { allInput, input, redirectBack } from '../../http.js';
import { image } from '../../images.js';
import { any, notFoundPage, registerFallback, route } from '../../router.js';
import { disk } from '../../storage.js';
import { render, sendServer500 } from '../../view.js';

const ROLES = ['admin', 'user', 'supplier'];
type Row = Record<string, unknown>;

// Request::has(): present and not an empty (blank) string.
function has(v: unknown): boolean {
  return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
}

function jsonStr(reply: FastifyReply, s: string): void {
  reply.type('application/json; charset=utf-8').send(JSON.stringify(s));
}

// PHP 7.4 is_numeric().
function isNumeric(v: unknown): boolean {
  return typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v);
}

// Request::expectsJson(): XHR (non-pjax) or the first Accept type is JSON.
function expectsJson(req: FastifyRequest): boolean {
  if (req.headers['x-requested-with'] === 'XMLHttpRequest' && !req.headers['x-pjax']) return true;
  const first = String(req.headers['accept'] ?? '').split(',')[0]?.split(';')[0]?.trim() ?? '';
  return first.includes('/json') || first.includes('+json');
}

// Grammar::wrap() for a raw sort column (backtick-quoted segments, `table.col` gets the os_ prefix).
function wrapColumn(column: string): string {
  const q = (s: string): string => (s === '*' ? s : `\`${s.replaceAll('`', '``')}\``);
  const segs = column.split('.');
  return segs.map((s, i) => (i === 0 && segs.length > 1 ? q(`os_${s}`) : q(s))).join('.');
}

// SupplierProduct JSON: all columns, then the eager-loaded relations.
async function withRelations(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r['id'] as number);
  // SAFETY: ids are numeric PKs; supplier_product_id is VARCHAR so MySQL compares numerically, like Eloquent's whereIn.
  const messages = (await db
    .selectFrom('os_supplier_product_messages')
    .selectAll()
    .where('supplier_product_id', 'in', ids as never)
    .orderBy('updated_at', 'desc')
    .execute()) as unknown as Row[];
  // SAFETY: selectAll() rows carry every column; read back as a Record.
  const images = (await db
    .selectFrom('os_supplier_product_images')
    .selectAll()
    .where('supplier_product_id', 'in', ids as never)
    .execute()) as unknown as Row[];
  return rows.map((r) => ({
    ...r,
    messages: messages.filter((m) => String(m['supplier_product_id']) === String(r['id'])),
    images: images.filter((m) => String(m['supplier_product_id']) === String(r['id'])),
  }));
}

// SupplierProduct@index (web.php:91-92).
async function index(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await render(req, reply, 'supplier/index');
}

// SupplierProduct@listProducts (web.php:95).
async function listProducts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = await currentUser(req);
  const adminOrUser = auth.roles.some((r) => r === 'admin' || r === 'user');
  let q = db.selectFrom('os_supplier_products').selectAll();
  if (!adminOrUser) q = q.where('supplier', '=', auth.user?.username ?? '');
  const filter = input<unknown>(req, 'filter');
  if (has(filter) && filter != '') q = q.where('name', 'like', `%${String(filter)}%`);
  const [{ total }] = (await q.clearSelect().select(sql`count(*)`.as('total')).execute()) as { total: number }[];
  const sort = input<unknown>(req, 'sort');
  if (has(sort) && sort != '') {
    const order = input<unknown>(req, 'order');
    const dir = has(order) && order != '' && String(order).toLowerCase() !== 'asc' ? 'desc' : 'asc';
    q = q.orderBy(sql.raw(`${wrapColumn(String(sort))} ${dir}`));
  }
  const page = input<unknown>(req, 'page');
  if (has(page) && isNumeric(page)) {
    const rawSize = input<unknown>(req, 'pageSize');
    const size = has(rawSize) && isNumeric(rawSize) ? Number(rawSize) : 100;
    // take() ignores a negative size, leaving `offset N` without a LIMIT (a MySQL syntax error in Laravel 5.4.36).
    if (size < 0) return sendServer500(req, reply);
    q = q.limit(Math.trunc(size)).offset(Math.max(0, Math.trunc(size * (Math.max(1, Number(page)) - 1))));
  }
  // SAFETY: selectAll() rows carry every column; read back as a Record.
  const products = await withRelations((await q.execute()) as unknown as Row[]);
  reply.send({ total, products });
}

// SupplierProduct@store (web.php:96,99).
async function store(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawId = (req.params as Record<string, string | undefined>)['id'];
  const hasId = rawId !== undefined && rawId !== '';
  const all = allInput(req);
  let product: Row | undefined;
  if (hasId) {
    // SAFETY: selectAll() rows carry every column; read back as a Record.
    product = (await db.selectFrom('os_supplier_products').selectAll().where('id', '=', Number(rawId)).executeTakeFirst()) as unknown as Row | undefined;
    if (!product) return notFoundPage(reply); // findOrFail
  } else {
    const errors: Record<string, string[]> = {};
    for (const field of ['name', 'supplier']) {
      const v = all[field];
      const msgs: string[] = [];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) {
        msgs.push(`The ${field} field is required.`);
      } else if ([...String(v)].length > 200) {
        msgs.push(`The ${field} may not be greater than 200 characters.`);
      }
      if (msgs.length > 0) errors[field] = msgs;
    }
    if (Object.keys(errors).length > 0) {
      if (expectsJson(req)) return void reply.code(422).send(errors);
      return void redirectBack(req, reply).withErrors(errors).withInput(all);
    }
  }
  const values: Row = { name: all['name'] ?? null, supplier: all['supplier'] ?? null };
  if (has(all['status'])) values['status'] = all['status'];
  values['entry_by'] = (await currentUser(req)).user?.username ?? null;
  if (product) {
    // Eloquent save(): only dirty attributes are written, updated_at only when something changed.
    const dirty = Object.keys(values).filter((k) => values[k] !== product![k]);
    if (dirty.length > 0) {
      const now = nowDb();
      for (const k of dirty) product[k] = values[k];
      product['updated_at'] = now;
      await db.updateTable('os_supplier_products').set({ ...Object.fromEntries(dirty.map((k) => [k, values[k]])), updated_at: now } as never).where('id', '=', Number(rawId)).execute();
    }
    return void reply.send(product);
  }
  const now = nowDb();
  const row = { ...values, updated_at: now, created_at: now };
  const result = await db.insertInto('os_supplier_products').values(row as never).executeTakeFirst();
  reply.send({ ...row, id: Number(result.insertId) });
}

// SupplierProduct@getAjax (web.php:97).
async function getAjax(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  // SAFETY: selectAll() rows carry every column; read back as a Record.
  const row = (await db.selectFrom('os_supplier_products').selectAll().where('id', '=', id).executeTakeFirst()) as unknown as Row | undefined;
  if (!row) return notFoundPage(reply);
  reply.send((await withRelations([row]))[0]);
}

// SupplierProduct@deleteProduct (web.php:100).
async function deleteProduct(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await db.selectFrom('os_supplier_products').select(['id']).where('id', '=', id).executeTakeFirst();
  if (!product) return notFoundPage(reply);
  await db.deleteFrom('os_supplier_product_messages').where('supplier_product_id', '=', String(id)).execute();
  const images = await db.selectFrom('os_supplier_product_images').select(['id', 'filename']).where('supplier_product_id', '=', String(id)).execute();
  for (const img of images) {
    if (await disk('supplier_product_image_full').exists(img.filename)) await disk('supplier_product_image_full').delete(img.filename);
    if (await disk('supplier_product_image_icon').exists(img.filename)) await disk('supplier_product_image_icon').delete(img.filename);
    await db.deleteFrom('os_supplier_product_images').where('id', '=', img.id).execute();
  }
  await db.deleteFrom('os_supplier_products').where('id', '=', id).execute();
  jsonStr(reply, 'ok');
}

// SupplierProduct@uploadMultipleImage (web.php:101).
async function uploadMultipleImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = String((req.params as Record<string, string>)['id']);
  const images: string[] = [];
  let counter = 0;
  let sawFiles = false;
  if (req.isMultipart()) {
    for await (const part of req.parts()) {
      // SAFETY: multipart part shape (file part -> stream, field part -> value).
      const p = part as { fieldname: string; filename?: string; file?: unknown; toBuffer: () => Promise<Buffer> };
      if (!p.file) continue;
      const buffer = await p.toBuffer();
      if (p.fieldname !== 'files') continue;
      sawFiles = true;
      // getClientOriginalExtension(): pathinfo EXTENSION, case kept.
      const ext = (p.filename ?? '').split('.').pop() ?? '';
      const filePath = `${id}_${Math.floor(Date.now() / 1000)}.${counter}.${ext}`;
      await disk('supplier_product_image_full').put(filePath, await image(buffer).widen(1000, (c) => c.upsize()).stream());
      await disk('supplier_product_image_icon').put(filePath, await image(buffer).widen(100, (c) => c.upsize()).stream());
      const now = nowDb();
      // SAFETY: full os_supplier_product_images column set + timestamps.
      await db.insertInto('os_supplier_product_images')
        .values({ supplier_product_id: id, original_name: p.filename ?? '', filename: filePath, created_at: now, updated_at: now } as never)
        .execute();
      images.push(filePath);
      counter++;
    }
  } else {
    // A JSON/form body can only carry `files` as an array (empty -> sizeof 0).
    const files = (allInput(req) as Row)['files'];
    sawFiles = Array.isArray(files);
  }
  if (!sawFiles) return sendServer500(req, reply); // sizeof(null)
  reply.send(images);
}

// SupplierProduct@deleteImage (web.php:102).
async function deleteImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = req.params as Record<string, string>;
  const rows = await db
    .selectFrom('os_supplier_product_images')
    .select(['id', 'filename'])
    .where('supplier_product_id', '=', params['id'])
    .where('id', '=', Number(params['image_id']))
    .execute();
  for (const r of rows) {
    await disk('supplier_product_image_full').delete(r.filename);
    await db.deleteFrom('os_supplier_product_images').where('id', '=', r.id).execute();
  }
  jsonStr(reply, 'ok');
}

// SupplierProduct@addMessage (web.php:103).
async function addMessage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = (req.params as Record<string, string>)['id'];
  const now = nowDb();
  const pm = {
    supplier_product_id: id,
    message: input(req, 'message'),
    entry_by: (await currentUser(req)).user?.username ?? null,
    updated_at: now,
    created_at: now,
  };
  const result = await db.insertInto('os_supplier_product_messages').values(pm as never).executeTakeFirst();
  reply.send({ ...pm, id: Number(result.insertId) });
}

// SupplierProduct@loadMessages (web.php:104).
async function loadMessages(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = (req.params as Record<string, string>)['id'];
  reply.send(await db.selectFrom('os_supplier_product_messages').selectAll().where('supplier_product_id', '=', id).orderBy('updated_at', 'desc').execute());
}

export function registerSupplierRoutes(app: FastifyInstance): void {
  // web.php:91 — regex catch-all, dispatched by T03's not-found fallback.
  registerFallback('Supplier', index);
  any(app, { path: '/SupplierProduct/{id?}', roles: ROLES, handler: index });
  route(app, { verb: 'get', path: '/api/supplierproducts', roles: ROLES, handler: listProducts });
  route(app, { verb: 'post', path: '/api/supplierproducts', roles: ROLES, handler: store });
  route(app, { verb: 'get', path: '/api/supplierproduct/{id}', roles: ROLES, handler: getAjax });
  route(app, { verb: 'post', path: '/api/supplierproduct/{id?}', roles: ROLES, handler: store });
  route(app, { verb: 'delete', path: '/api/supplierproduct/{id}', roles: ROLES, handler: deleteProduct });
  route(app, { verb: 'post', path: '/api/supplierproduct/{id}/images', roles: ROLES, handler: uploadMultipleImage });
  route(app, { verb: 'delete', path: '/api/supplierproduct/{id}/images/{image_id}', roles: ROLES, handler: deleteImage });
  route(app, { verb: 'post', path: '/api/supplierproduct/{id}/messages', roles: ROLES, handler: addMessage });
  route(app, { verb: 'get', path: '/api/supplierproduct/{id}/messages', roles: ROLES, handler: loadMessages });
}
