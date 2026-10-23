// BulkProductionController (routes/web.php:241-248, role:admin,user,remote).
//
// Quirks kept (plan/NOTES.md):
// - Laravel 5.4 positional splice: show/update/destroy take (Request $request, $id=0);
//   the resource {BulkProduction} param value lands in $id, the ?id= fallback only
//   applies when no route param is present (resource params are optional, so
//   bare PUT/PATCH/DELETE /BulkProduction work too).
// - /BulkProduction.updateFollowUp 500s: the route names updateFollowUp, which does
//   not exist on the controller (it has updateBulkProduction) — the old app fatals
//   (verified live on :6999).
// - store() re-encodes uploads via Image::make()->widen(1000, upsize);
//   updateImages() writes the new uploads RAW (file_get_contents, no re-encode).
// - create/edit views are one-line literal Mac-path files (T19/T20 situation),
//   kept byte-for-byte.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { allInput, input } from '../../http.js';
import { image } from '../../images.js';
import { disk } from '../../storage.js';
import { any, resource, route } from '../../router.js';
import { render, sendServer500, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

function notFound(): never {
  throw Object.assign(new Error('BulkProduction not found'), { statusCode: 404 });
}

// findOrFail() -> 404 via the app's not-found flow.
async function findBulkProduction(id: unknown): Promise<Row> {
  // SAFETY: a full os_bulk_productions row (Eloquent serialises all columns).
  const row = (await db
    .selectFrom('os_bulk_productions')
    .selectAll()
    .where('id', '=', id as number)
    .executeTakeFirst()) as unknown as Row;
  if (!row) notFound();
  return row;
}

// $id param (positional splice, see module header), else $request->get('id').
// $fields: multipart field parts (not in req.body); $request->get('id') reads
// them in the old app.
function reqId(req: FastifyRequest, fields?: Record<string, unknown>): string | number | null {
  const p = (req.params as Record<string, unknown> | undefined)?.['BulkProduction'];
  if (p !== undefined && p !== '') return String(p);
  if (fields && 'id' in fields) return fields['id'] as string | number;
  const v = input(req, 'id');
  return v === undefined ? null : (v as string | number);
}

// PHP `$v == null`: true for null, '', 0, '0' and false.
function phpEqNull(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === 0 || v === '0' || v === false;
}

// getClientOriginalExtension(): pathinfo(..., PATHINFO_EXTENSION), case kept.
function extOf(filename: string): string {
  return filename.split('.').pop() ?? '';
}

interface UploadedFile {
  filename: string;
  buffer: Buffer;
}

// Request input: text fields (query + body, or multipart field parts) + the
// images[] file parts. Multipart field parts are not in req.body
// (attachFieldsToBody false), and file parts must be drained while iterating
// (T19: busboy pauses until a file part is consumed).
async function requestData(
  req: FastifyRequest,
): Promise<{ data: Record<string, unknown>; files: UploadedFile[] }> {
  const files: UploadedFile[] = [];
  if (req.isMultipart()) {
    const data: Record<string, unknown> = {};
    for await (const part of req.parts()) {
      // SAFETY: Multipart shape (field part -> value, file part -> stream).
      const p = part as {
        fieldname: string;
        filename?: string;
        file?: unknown;
        value?: string;
        toBuffer: () => Promise<Buffer>;
      };
      if (p.file) {
        if (p.fieldname === 'images[]') files.push({ filename: p.filename ?? '', buffer: await p.toBuffer() });
      } else {
        data[p.fieldname] = String(p.value);
      }
    }
    return { data, files };
  }
  return { data: allInput(req), files };
}

// ---------------------------------------------------------------- handlers

async function index(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_bulk_productions rows.
  const rows = (await db
    .selectFrom('os_bulk_productions')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(50)
    .execute()) as unknown as Row[];
  // The view's <?php ... ?> cell: anchors for the images that exist on the
  // bulk_production disk (Storage::disk('bulk_production')->exists).
  const pd = disk('bulk_production');
  for (const r of rows) {
    let html = '';
    for (const part of String(r.images ?? '').split('|||')) {
      if (part.trim().length > 0 && (await pd.exists(part))) {
        const u = url(`/storage/bulk_production/${part}`);
        html += `<a href='${u}' target='_blank'><img src='${u}' style='width:150px'></a>`;
      }
    }
    r.imagesHtml = html;
  }
  await render(req, reply, 'bulkproduction/index', { bulkProductions: rows });
}

async function ajaxindex(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_bulk_productions rows.
  const rows = (await db
    .selectFrom('os_bulk_productions')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(50)
    .execute()) as unknown as Row[];
  reply.send(rows);
}

async function create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The ported view is the literal path text of the old broken file.
  await render(req, reply, 'bulkproduction/create');
}

async function store(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { data, files } = await requestData(req);
  // BulkProduction::create($data): fillable eta/notes/images; $request->get()
  // is null when absent.
  const ts = nowDb();
  const values: Row = {
    images: '',
    eta: data.eta ?? null,
    notes: data.notes ?? null,
    created_at: ts,
    updated_at: ts,
  };
  // SAFETY: fillable columns + timestamps; runtime values mirror Laravel create().
  const res = await db.insertInto('os_bulk_productions').values(values as never).executeTakeFirst();
  const id = Number(res.insertId);
  // Image::make($file->getRealPath())->widen(1000, upsize) — re-encoded stream.
  const pd = disk('bulk_production');
  let images = '';
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const img = await image(file.buffer).widen(1000, (c) => c.upsize()).stream();
    const filePath = `${id}_${i}.${extOf(file.filename)}`;
    await pd.put(filePath, img);
    images += filePath + '|||';
  }
  if (images !== '') {
    // save() only writes dirty attributes: with no files images stays ''.
    // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
    await db
      .updateTable('os_bulk_productions')
      .set({ images, updated_at: nowDb() as unknown as Date })
      .where('id', '=', id)
      .execute();
  }
  reply.send(await findBulkProduction(id));
}

async function show(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await findBulkProduction(reqId(req)));
}

async function edit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // find($id) (nullable) + the ported view is the literal path text.
  void reqId(req);
  await render(req, reply, 'bulkproduction/edit');
}

async function update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { data } = await requestData(req);
  const id = reqId(req, data);
  await findBulkProduction(id);
  // $request->only('eta', 'notes'); each dropped when == null (PHP ==: also '0').
  const set: Row = {};
  for (const k of ['eta', 'notes']) {
    if (!(k in data)) continue;
    if (phpEqNull(data[k])) continue;
    set[k] = data[k];
  }
  // SAFETY: only fillable columns + the nowDb() timestamp string.
  const setValues = { ...set, updated_at: nowDb() } as never;
  await db.updateTable('os_bulk_productions').set(setValues).where('id', '=', id as number).execute();
  reply.send(await findBulkProduction(id));
}

// Route exists (web.php:245) but the controller has no updateFollowUp method
// (it has updateBulkProduction) — the old app 500s (verified live on :6999).
async function updateFollowUp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await sendServer500(req, reply);
}

async function destroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  const row = await findBulkProduction(id);
  const pd = disk('bulk_production');
  for (const part of String(row.images ?? '').split('|||')) {
    if (part.trim().length > 0 && (await pd.exists(part))) await pd.delete(part);
  }
  await db.deleteFrom('os_bulk_productions').where('id', '=', id as number).execute();
  reply.type('application/json; charset=utf-8').send(JSON.stringify('deleted'));
}

async function updateImages(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { data, files } = await requestData(req);
  const id = reqId(req, data);
  const row = await findBulkProduction(id);
  // $data['images'] = $bulkProduction->images; on upload: delete existing,
  // reset, append the new RAW uploads (file_get_contents — no re-encode).
  let images = String(row.images ?? '');
  if (files.length > 0) {
    const pd = disk('bulk_production');
    for (const part of images.split('|||')) {
      if (part.trim().length > 0 && (await pd.exists(part))) await pd.delete(part);
    }
    images = '';
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = `${id}_${i}.${extOf(file.filename)}`;
      await pd.put(filePath, file.buffer);
      images += filePath + '|||';
    }
  }
  const set: Row = {};
  // update($data): fillable eta/notes (dropped when == null) + images.
  for (const k of ['eta', 'notes']) {
    if (!(k in data)) continue;
    if (phpEqNull(data[k])) continue;
    set[k] = data[k];
  }
  if (images !== String(row.images ?? '')) set.images = images;
  // SAFETY: only fillable columns + the nowDb() timestamp string.
  const setValues = { ...set, updated_at: nowDb() } as never;
  await db.updateTable('os_bulk_productions').set(setValues).where('id', '=', id as number).execute();
  reply.send(await findBulkProduction(id));
}

export function registerBulkProductionRoutes(app: FastifyInstance): void {
  resource(app, '/BulkProduction', {
    index,
    create,
    store,
    show,
    edit,
    update,
    destroy,
  }, { roles: ROLES });
  // Laravel 5.4 resource params are optional ({BulkProduction?}): bare
  // PUT/DELETE /BulkProduction (no param) fall through to the ?id= query.
  route(app, { verb: 'put', path: '/BulkProduction', roles: ROLES, handler: update });
  route(app, { verb: 'patch', path: '/BulkProduction', roles: ROLES, handler: update });
  route(app, { verb: 'delete', path: '/BulkProduction', roles: ROLES, handler: destroy });
  any(app, { path: '/BulkProduction.show', name: 'BulkProduction.show', roles: ROLES, handler: show });
  any(app, { path: '/BulkProduction.store', name: 'BulkProduction.store', roles: ROLES, handler: store });
  any(app, { path: '/BulkProduction.update', name: 'BulkProduction.update', roles: ROLES, handler: update });
  any(app, { path: '/BulkProduction.updateFollowUp', name: 'BulkProduction.updateFollowUp', roles: ROLES, handler: updateFollowUp });
  any(app, { path: '/BulkProduction.destroy', name: 'BulkProduction.destroy', roles: ROLES, handler: destroy });
  any(app, { path: '/BulkProduction.ajax', name: 'BulkProduction.ajax', roles: ROLES, handler: ajaxindex });
  route(app, { verb: 'post', path: '/BulkProduction.updateImages', name: 'BulkProduction.updateImages', roles: ROLES, handler: updateImages });
}
