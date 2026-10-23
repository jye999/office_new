// ProductionController (routes/web.php:250-256, role:admin,user,remote).
//
// Quirks kept (plan/NOTES.md):
// - Laravel 5.4 splice: show/edit/update/destroy take (Request $request, $id=0),
//   and the route param value lands in $id POSITIONALLY (RouteDependencyResolver
//   splices the first free route value into the first unmatched parameter).
//   So /Production/16 (the resource's {production} param) reaches $id; the
//   ?id= fallback only applies when no route param is present (Laravel's
//   resource params are optional, so PUT/DELETE /Production work too).
// - /Production.updateFollowUp 500s: the route names updateFollowUp, which
//   does not exist on the controller (it has updateProduction) — the old app
//   fatals. Ported via sendServer500 (verified live on :6999).
// - store() returns plain-text 'failed' (200) when the name-required validator fails.
// - update() drops the listed fields that are absent or == null (PHP ==: also '0').
// - edit() renders productions/edit, which in the old app is a one-line file
//   containing a literal path (kept byte-for-byte).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { allInput, input } from '../../http.js';
import { image } from '../../images.js';
import { disk } from '../../storage.js';
import { any, resource, route } from '../../router.js';
import { render, sendServer500, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

// Production::$fillable
const FILLABLE = ['name', 'production_date', 'notes', 'target_qty', 'finished_qty', 'assignTo', 'images'];
// Fields update() unsets when absent or == null
const UPDATE_DROP = ['name', 'production_date', 'assignTo', 'notes', 'target_qty', 'finished_qty', 'images'];

// findOrFail() -> 404 via the app's not-found flow.
function notFound(): never {
  throw Object.assign(new Error('Production not found'), { statusCode: 404 });
}

async function findProduction(id: unknown): Promise<Row> {
  // SAFETY: a full os_productions row (Eloquent serialises all columns).
  const row = (await db.selectFrom('os_productions').selectAll().where('id', '=', id as number).executeTakeFirst()) as unknown as Row;
  if (!row) notFound();
  return row;
}

// $id param (positional splice, see module header), else $request->get('id').
function reqId(req: FastifyRequest): string | number | null {
  // Param name is 'Production' (T03 singular() keeps the 's'; fastify keys keep case).
  const p = (req.params as Record<string, unknown> | undefined)?.['Production'];
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

// Laravel `required` (name): fails on missing/null/''/empty array.
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

// Production::create($data) with $timestamps (Eloquent defaults).
async function createProduction(data: Record<string, unknown>): Promise<number> {
  const ts = nowDb();
  const values: Row = { created_at: ts, updated_at: ts };
  for (const [k, v] of Object.entries(massAssign(data))) values[k] = v === false ? 0 : v;
  // SAFETY: fillable columns + timestamps; runtime values mirror Laravel create().
  const res = await db.insertInto('os_productions').values(values as never).executeTakeFirst();
  return Number(res.insertId);
}

// ---------------------------------------------------------------- handlers

async function index(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_productions rows.
  const rows = (await db.selectFrom('os_productions').selectAll().orderBy('id', 'desc').execute()) as unknown as Row[];
  // The view's <?php ... ?> cell: anchors for the images that exist on the
  // production disk (trailing space inside href/src kept from the PHP echo).
  const pd = disk('production');
  for (const r of rows) {
    let html = '';
    for (const part of String(r.images ?? '').split('|||')) {
      if (part.trim().length > 0 && (await pd.exists(part))) {
        const u = url(`/storage/production/${part}`);
        html += `<a href='${u} ' target='_blank'><img src='${u} ' style='width:150px'></a>`;
      }
    }
    r.imagesHtml = html;
  }
  await render(req, reply, 'productions/index', { productions: rows });
}

async function ajaxindex(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_productions rows.
  const rows = (await db
    .selectFrom('os_productions')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(50)
    .execute()) as unknown as Row[];
  reply.send(rows);
}

async function create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The ported view is the literal path text of the old broken file.
  await render(req, reply, 'productions/create');
}

async function store(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { data, files } = await multipartData(req);
  // $request->all(): multipart fields, then body (body wins; query is not part of all()).
  for (const [k, v] of Object.entries(req.body ?? {})) if (!(k in data)) data[k] = v;
  const all: Record<string, unknown> = { ...data };
  if (!('target_qty' in all)) all['target_qty'] = 0;
  if (!('finished_qty' in all)) all['finished_qty'] = 0;
  if (requiredFails(all['name'])) {
    // return 'failed' (plain-text 200)
    return reply.type('text/html; charset=UTF-8').send('failed');
  }
  all['images'] = '';
  const id = await createProduction(all);
  let images = '';
  const pd = disk('production');
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const img = await image(file.buffer).widen(1000, (c) => c.upsize()).stream();
    // getClientOriginalExtension(): pathinfo(..., PATHINFO_EXTENSION), case kept.
    const ext = file.filename.split('.').pop() ?? '';
    const filePath = `${id}_${i}.${ext}`;
    await pd.put(filePath, img);
    images += filePath + '|||';
  }
  const row = await findProduction(id);
  if (images !== row.images) {
    // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
    await db.updateTable('os_productions').set({ images, updated_at: nowDb() as unknown as Date }).where('id', '=', id).execute();
  }
  reply.send(await findProduction(id));
}

async function show(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await findProduction(reqId(req)));
}

async function edit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Find($id) (nullable) + the ported view is the literal path text.
  void reqId(req);
  await render(req, reply, 'productions/edit');
}

async function update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  await findProduction(id);
  const all = allInput(req);
  const set: Row = {};
  for (const k of UPDATE_DROP) {
    if (!(k in all)) continue;
    if (phpEqNull(all[k])) continue;
    set[k] = all[k];
  }
  // SAFETY: only fillable columns + the nowDb() timestamp string.
  const setValues = { ...set, updated_at: nowDb() } as never;
  await db.updateTable('os_productions').set(setValues).where('id', '=', id as number).execute();
  reply.send(await findProduction(id));
}

// Route exists (web.php:254) but the controller has no updateFollowUp method
// (it has updateProduction) — the old app 500s (verified live on :6999).
async function updateFollowUp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await sendServer500(req, reply);
}

async function destroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  const production = await findProduction(id);
  const pd = disk('production');
  for (const part of String(production.images ?? '').split('|||')) {
    if (part.trim().length > 0 && (await pd.exists(part))) await pd.delete(part);
  }
  await db.deleteFrom('os_productions').where('id', '=', id as number).execute();
  reply.type('application/json; charset=utf-8').send(JSON.stringify('deleted'));
}

export function registerProductionRoutes(app: FastifyInstance): void {
  resource(app, '/Production', {
    index,
    create,
    store,
    show,
    edit,
    update,
    destroy,
  }, { roles: ROLES });
  // Laravel 5.4 resource params are optional ({production?}): PUT/DELETE /Production
  // (no param) fall through to the ?id= query, so the bare paths exist too.
  route(app, { verb: 'put', path: '/Production', roles: ROLES, handler: update });
  route(app, { verb: 'patch', path: '/Production', roles: ROLES, handler: update });
  route(app, { verb: 'delete', path: '/Production', roles: ROLES, handler: destroy });
  any(app, { path: '/Production.show', name: 'Production.show', roles: ROLES, handler: show });
  any(app, { path: '/Production.store', name: 'Production.store', roles: ROLES, handler: store });
  any(app, { path: '/Production.update', name: 'Production.update', roles: ROLES, handler: update });
  any(app, { path: '/Production.updateFollowUp', name: 'Production.updateFollowUp', roles: ROLES, handler: updateFollowUp });
  any(app, { path: '/Production.destroy', name: 'Production.destroy', roles: ROLES, handler: destroy });
  any(app, { path: '/Production.ajax', name: 'Production.ajax', roles: ROLES, handler: ajaxindex });
}
