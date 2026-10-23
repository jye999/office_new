// PurchaseController (routes/web.php:258-264, role:admin,user,remote).
//
// Quirks kept (plan/NOTES.md):
// - Laravel 5.4 splice: show/edit/update/destroy take (Request $request, $id=0),
//   and the route param value lands in $id POSITIONALLY (RouteDependencyResolver
//   splices the first free route value into the first unmatched parameter).
//   So /Purchase/12 (the resource's {purchase} param) reaches $id; the ?id=
//   fallback only applies when no route param is present (Laravel's resource
//   params are optional, so PUT/DELETE /Purchase work too).
// - /Purchase.updateFollowUp 500s: the route names updateFollowUp, which does
//   not exist on the controller (it has updatePurchase) — the old app fatals.
//   Ported via sendServer500 (verified live on :6999).
// - /Purchase/{id}/edit 500s: view('purchase.edit') does not exist in the old
//   app (verified live on :6999). Ported via sendServer500.
// - store() returns plain-text 'failed' (200) when the name/qty-required
//   validator fails.
// - update() drops the listed fields that are absent or == null (PHP ==: also '0').

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { allInput, input } from '../../http.js';
import { image } from '../../images.js';
import { disk } from '../../storage.js';
import { any, resource, route } from '../../router.js';
import { render, sendServer500, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

// Purchase::$fillable
const FILLABLE = ['name', 'sku', 'request_date', 'notes', 'current_qty', 'qty', 'status', 'images'];
// Fields update() unsets when absent or == null
const UPDATE_DROP = ['name', 'qty', 'sku', 'request_date', 'notes', 'status', 'current_qty', 'images'];

// findOrFail() -> 404 via the app's not-found flow.
function notFound(): never {
  throw Object.assign(new Error('Purchase not found'), { statusCode: 404 });
}

async function findPurchase(id: unknown): Promise<Row> {
  // SAFETY: a full os_purchases row (Eloquent serialises all columns).
  const row = (await db.selectFrom('os_purchases').selectAll().where('id', '=', id as number).executeTakeFirst()) as unknown as Row;
  if (!row) notFound();
  return row;
}

// $id param (positional splice, see module header), else $request->get('id').
function reqId(req: FastifyRequest): string | number | null {
  // Param name is 'Purchase' (T03 singular() keeps the 's'; fastify keys keep case).
  const p = (req.params as Record<string, unknown> | undefined)?.['Purchase'];
  if (p !== undefined && p !== '') return String(p);
  const v = input(req, 'id');
  return v === undefined ? null : (v as string | number);
}

// PHP `$v == null`: true for null, '', 0, '0' and false.
function phpEqNull(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === 0 || v === '0' || v === false;
}

// Eloquent mass assignment: keep only fillable keys that were present.
function massAssign(data: Record<string, unknown>): Row {
  const out: Row = {};
  for (const k of FILLABLE) if (k in data) out[k] = data[k];
  return out;
}

// Laravel `required` (name, qty): fails on missing/null/''/empty array.
function requiredFails(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

interface UploadedFile {
  filename: string;
  buffer: Buffer;
}

// Multipart request: field parts are not in req.body (attachFieldsToBody
// false), so collect text fields + the images[] file parts by hand.
async function multipartData(req: FastifyRequest): Promise<{ data: Record<string, unknown>; files: UploadedFile[] }> {
  const data: Record<string, unknown> = {};
  const files: UploadedFile[] = [];
  if (req.isMultipart()) {
    for await (const part of req.parts()) {
      // SAFETY: Multipart shape (field part -> value, file part -> stream).
      const p = part as { fieldname: string; filename?: string; file?: unknown; value?: string; toBuffer: () => Promise<Buffer> };
      if (p.file) {
        // Consume the stream here: busboy pauses until a file part is drained.
        if (p.fieldname === 'images[]') files.push({ filename: p.filename ?? '', buffer: await p.toBuffer() });
      } else {
        data[p.fieldname] = String(p.value);
      }
    }
  }
  return { data, files };
}

// Purchase::create($data) with $timestamps (Eloquent defaults).
async function createPurchase(data: Record<string, unknown>): Promise<number> {
  const ts = nowDb();
  const values: Row = { created_at: ts, updated_at: ts };
  for (const [k, v] of Object.entries(massAssign(data))) values[k] = v === false ? 0 : v;
  // SAFETY: fillable columns + timestamps; runtime values mirror Laravel create().
  const res = await db.insertInto('os_purchases').values(values as never).executeTakeFirst();
  return Number(res.insertId);
}

// ---------------------------------------------------------------- handlers

async function index(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_purchases rows.
  const rows = (await db.selectFrom('os_purchases').selectAll().orderBy('id', 'desc').execute()) as unknown as Row[];
  // The view's <?php ... ?> cell: anchors for the images that exist on the
  // purchase disk (trailing space inside href/src kept from the PHP echo).
  const pu = disk('purchase');
  for (const r of rows) {
    let html = '';
    for (const part of String(r.images ?? '').split('|||')) {
      if (part.trim().length > 0 && (await pu.exists(part))) {
        const u = url(`/storage/purchase/${part}`);
        html += `<a href='${u} ' target='_blank'><img src='${u} ' style='width:150px'></a>`;
      }
    }
    r.imagesHtml = html;
  }
  await render(req, reply, 'purchases/index', { purchases: rows });
}

async function ajaxindex(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_purchases rows.
  const rows = (await db
    .selectFrom('os_purchases')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(50)
    .execute()) as unknown as Row[];
  reply.send(rows);
}

async function create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The ported view is the literal path text of the old broken file.
  await render(req, reply, 'purchases/create');
}

async function store(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { data, files } = await multipartData(req);
  // $request->all(): multipart fields, then body (body wins; query is not part of all()).
  for (const [k, v] of Object.entries(req.body ?? {})) if (!(k in data)) data[k] = v;
  const all: Record<string, unknown> = { ...data };
  if (!('current_qty' in all)) all['current_qty'] = 0;
  if (requiredFails(all['name']) || requiredFails(all['qty'])) {
    // return 'failed' (plain-text 200)
    return reply.type('text/html; charset=UTF-8').send('failed');
  }
  all['images'] = '';
  const id = await createPurchase(all);
  let images = '';
  const pu = disk('purchase');
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const img = await image(file.buffer).widen(1000, (c) => c.upsize()).stream();
    // getClientOriginalExtension(): pathinfo(..., PATHINFO_EXTENSION), case kept.
    const ext = file.filename.split('.').pop() ?? '';
    const filePath = `${id}_${i}.${ext}`;
    await pu.put(filePath, img);
    images += filePath + '|||';
  }
  const row = await findPurchase(id);
  if (images !== row.images) {
    // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
    await db.updateTable('os_purchases').set({ images, updated_at: nowDb() as unknown as Date }).where('id', '=', id).execute();
  }
  reply.send(await findPurchase(id));
}

async function show(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await findPurchase(reqId(req)));
}

// view('purchase.edit') does not exist in the old app -> 500 (verified live).
async function edit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  void reqId(req);
  await sendServer500(req, reply);
}

async function update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  await findPurchase(id);
  const all = allInput(req);
  const set: Row = {};
  for (const k of UPDATE_DROP) {
    if (!(k in all)) continue;
    if (phpEqNull(all[k])) continue;
    set[k] = all[k];
  }
  // SAFETY: only fillable columns + the nowDb() timestamp string.
  const setValues = { ...set, updated_at: nowDb() } as never;
  await db.updateTable('os_purchases').set(setValues).where('id', '=', id as number).execute();
  reply.send(await findPurchase(id));
}

// Route exists (web.php:262) but the controller has no updateFollowUp method
// (it has updatePurchase) — the old app 500s (verified live on :6999).
async function updateFollowUp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await sendServer500(req, reply);
}

async function destroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  const purchase = await findPurchase(id);
  const pu = disk('purchase');
  for (const part of String(purchase.images ?? '').split('|||')) {
    if (part.trim().length > 0 && (await pu.exists(part))) await pu.delete(part);
  }
  await db.deleteFrom('os_purchases').where('id', '=', id as number).execute();
  reply.type('application/json; charset=utf-8').send(JSON.stringify('deleted'));
}

export function registerPurchaseRoutes(app: FastifyInstance): void {
  resource(app, '/Purchase', {
    index,
    create,
    store,
    show,
    edit,
    update,
    destroy,
  }, { roles: ROLES });
  // Laravel 5.4 resource params are optional ({purchase?}): PUT/DELETE /Purchase
  // (no param) fall through to the ?id= query, so the bare paths exist too.
  route(app, { verb: 'put', path: '/Purchase', roles: ROLES, handler: update });
  route(app, { verb: 'patch', path: '/Purchase', roles: ROLES, handler: update });
  route(app, { verb: 'delete', path: '/Purchase', roles: ROLES, handler: destroy });
  any(app, { path: '/Purchase.show', name: 'Purchase.show', roles: ROLES, handler: show });
  any(app, { path: '/Purchase.store', name: 'Purchase.store', roles: ROLES, handler: store });
  any(app, { path: '/Purchase.update', name: 'Purchase.update', roles: ROLES, handler: update });
  any(app, { path: '/Purchase.updateFollowUp', name: 'Purchase.updateFollowUp', roles: ROLES, handler: updateFollowUp });
  any(app, { path: '/Purchase.destroy', name: 'Purchase.destroy', roles: ROLES, handler: destroy });
  any(app, { path: '/Purchase.ajax', name: 'Purchase.ajax', roles: ROLES, handler: ajaxindex });
}
