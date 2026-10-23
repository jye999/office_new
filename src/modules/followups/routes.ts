// FollowUpsController (routes/web.php:231-239, role:admin,user,remote).
//
// Quirks kept (plan/NOTES.md):
// - Laravel binds route params by NAME; the resource param is {followup} but
//   the controller methods take $id, so show/update/destroy/updateTracking
//   always see $id=0 and fall back to the ?id= query. The resource's
//   {followup} param is therefore ignored (a GET /FollowUps/5 404s, exactly
//   like the old app).
// - store() returns the plain-text body 'failed' (200) when the
//   orderId-required validator fails.
// - update() drops only()-listed fields that compare == null (null/''/0);
//   `done` is never dropped.
// - findCustomerByOrderId: the $store/$storeName/$buyer lookups are dead code;
//   no order found -> empty 200.
// - updateTracking saves the tracking number to the row as-is (no external
//   tracking API is ever called).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { allInput, input } from '../../http.js';
import { image } from '../../images.js';
import { disk } from '../../storage.js';
import { any, resource } from '../../router.js';
import { render, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

// Followup::$fillable
const FILLABLE = ['orderId', 'followup_date', 'cs_user', 'notes', 'done', 'assignTo', 'images', 'tracking'];

// findOrFail() -> 404 via the app's not-found flow (T18 pattern).
function notFound(): never {
  throw Object.assign(new Error('Followup not found'), { statusCode: 404 });
}

async function findFollowup(id: unknown): Promise<Row> {
  const row = await db.selectFrom('os_follow_ups').selectAll().where('id', '=', id as number).executeTakeFirst();
  if (!row) notFound();
  // SAFETY: a full os_follow_ups row (Eloquent serialises all columns).
  return row as unknown as Row;
}

// $id==0 -> $request->get('id') (see module header for why the route param is
// never used).
function reqId(req: FastifyRequest): string | number | null {
  // Laravel 5.4 positional splice (found in T20): the resource path param lands in $id.
  const params = Object.values((req.params as Record<string, unknown> | undefined) ?? {});
  const p = params.find((x) => x !== undefined && x !== '');
  if (p !== undefined) return String(p);
  const v = input(req, 'id');
  return v === undefined ? null : (v as string | number);
}

// PHP `$v == null`: true for null, '' and the number 0 ('0' is kept).
function phpEqNull(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === 0;
}

// Eloquent mass assignment: keep only fillable keys that were present.
function massAssign(data: Record<string, unknown>): Row {
  const out: Row = {};
  for (const k of FILLABLE) if (k in data) out[k] = data[k];
  return out;
}

// Laravel `required` (orderId): fails on missing/null/''/empty array.
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
    // req.parts() (not req.files()): files() skips field parts, where the
    // upload form's text inputs live.
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

// Followup::create($data) with $timestamps (Eloquent defaults).
async function createFollowup(data: Record<string, unknown>): Promise<number> {
  const ts = nowDb();
  const values: Row = { created_at: ts, updated_at: ts };
  for (const [k, v] of Object.entries(massAssign(data))) values[k] = v === false ? 0 : v;
  // SAFETY: fillable columns + timestamps; runtime values mirror Laravel create().
  const res = await db.insertInto('os_follow_ups').values(values as never).executeTakeFirst();
  return Number(res.insertId);
}

// ---------------------------------------------------------------- handlers

async function index(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_follow_ups rows (cont. pattern).
  const rows = (await db
    .selectFrom('os_follow_ups')
    .selectAll()
    .where('done', '<>', 1)
    .orderBy('id', 'desc')
    .limit(50)
    .execute()) as unknown as Row[];
  // The view's <?php ... ?> cell: anchors for the images that exist on the
  // follow_up disk (trailing space inside href/src kept from the PHP echo).
  const fu = disk('follow_up');
  for (const r of rows) {
    let html = '';
    for (const part of String(r.images ?? '').split('|||')) {
      if (part.trim().length > 0 && (await fu.exists(part))) {
        const u = url(`/storage/follow_up/${part}`);
        html += `<a href='${u} ' target='_blank'><img src='${u} ' style='width:150px'></a>`;
      }
    }
    r.imagesHtml = html;
  }
  await render(req, reply, 'followups/index', { followups: rows });
}

async function ajaxindex(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: rows are full os_follow_ups rows (cont. pattern).
  const rows = (await db
    .selectFrom('os_follow_ups')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(50)
    .execute()) as unknown as Row[];
  reply.send(rows);
}

// create(): the ported view is the literal path text of the old broken file.
async function create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await render(req, reply, 'followups/create');
}

async function store(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { data, files } = await multipartData(req);
  // $request->all(): multipart fields, then body, then query (body wins).
  for (const [k, v] of Object.entries(req.body ?? {})) if (!(k in data)) data[k] = v;
  for (const [k, v] of Object.entries(req.query ?? {})) if (!(k in data)) data[k] = v;
  const all: Record<string, unknown> = { ...data };
  if (requiredFails(all['orderId'])) {
    // return 'failed' (plain-text 200)
    return reply.type('text/html; charset=UTF-8').send('failed');
  }
  if (!('done' in all)) all['done'] = false;
  all['images'] = '';
  const id = await createFollowup(all);
  let images = '';
  const fu = disk('follow_up');
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const img = await image(file.buffer).widen(1000, (c) => c.upsize()).stream();
    // getClientOriginalExtension(): pathinfo(..., PATHINFO_EXTENSION), case kept.
    const ext = file.filename.split('.').pop() ?? '';
    const filePath = `${id}_${i}.${ext}`;
    await fu.put(filePath, img);
    images += filePath + '|||';
  }
  const row = await findFollowup(id);
  if (images !== row.images) {
    // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
    await db.updateTable('os_follow_ups').set({ images, updated_at: nowDb() as unknown as Date }).where('id', '=', id).execute();
  }
  reply.send(await findFollowup(id));
}

async function show(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await findFollowup(reqId(req)));
}

async function edit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Find($id) (nullable) + the ported view is the literal path text.
  void reqId(req);
  await render(req, reply, 'followups/edit');
}

async function update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await findFollowup(reqId(req));
  const only: string[] = ['orderId', 'followup_date', 'cs_user', 'notes', 'done', 'assignTo'];
  const all = allInput(req);
  const set: Row = {};
  for (const k of only) {
    if (!(k in all)) continue;
    if (k !== 'done' && phpEqNull(all[k])) continue;
    set[k] = all[k];
  }
  // SAFETY: only fillable columns + the nowDb() timestamp string.
  const setValues = { ...set, updated_at: nowDb() } as never;
  await db.updateTable('os_follow_ups').set(setValues).where('id', '=', reqId(req) as number).execute();
  reply.send(await findFollowup(reqId(req)));
}

async function updateTracking(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  await findFollowup(id);
  // SAFETY: $request->tracking is a plain string field (null when absent).
  const tracking = input(req, 'tracking') as string | null;
  // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
  const ts = nowDb() as unknown as Date;
  await db
    .updateTable('os_follow_ups')
    .set({ tracking, updated_at: ts })
    .where('id', '=', id as number)
    .execute();
  reply.type('application/json; charset=utf-8').send(JSON.stringify('ok'));
}

async function updateFollowUp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  const followup = await findFollowup(id);
  const { data, files } = await multipartData(req);
  for (const [k, v] of Object.entries(req.body ?? {})) if (!(k in data)) data[k] = v;
  for (const [k, v] of Object.entries(req.query ?? {})) if (!(k in data)) data[k] = v;
  const all: Record<string, unknown> = { ...data };
  for (const k of ['orderId', 'followup_date', 'cs_user', 'notes', 'assignTo']) {
    if (phpEqNull(all[k])) delete all[k];
  }
  // Existing images are the base; NEW files are appended RAW (no re-encode).
  let images = String(followup.images ?? '');
  const fu = disk('follow_up');
  for (let i = 0; i < files.length; i++) {
    const buf = files[i].buffer;
    const ext = files[i].filename.split('.').pop() ?? '';
    const filePath = `${id}_${i}.${ext}`;
    await fu.put(filePath, buf);
    images += filePath + '|||';
  }
  all['images'] = images;
  const set: Row = massAssign(all);
  // SAFETY: only fillable columns + the nowDb() timestamp string.
  const setValues = { ...set, updated_at: nowDb() } as never;
  await db.updateTable('os_follow_ups').set(setValues).where('id', '=', id as number).execute();
  reply.send(await findFollowup(id));
}

async function destroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = reqId(req);
  const followup = await findFollowup(id);
  const fu = disk('follow_up');
  for (const part of String(followup.images ?? '').split('|||')) {
    if (part.trim().length > 0 && (await fu.exists(part))) await fu.delete(part);
  }
  await db.deleteFrom('os_follow_ups').where('id', '=', id as number).execute();
  reply.type('application/json; charset=utf-8').send(JSON.stringify('deleted'));
}

// GrantOrder::with('detail','tracking')->where('orderId','=',$orderId)->first()
// serialized: scalar columns then the loaded relations (lowercase keys).
async function findCustomerByOrderId(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orderId = input(req, 'orderId');
  if (orderId === null || orderId === undefined) return reply.type('text/html; charset=UTF-8').send('');
  // SAFETY: a full os_grant_order row (Eloquent serialises all columns).
  const order = (await db
    .selectFrom('os_grant_order')
    .selectAll()
    .where('orderId', '=', orderId as string)
    .executeTakeFirst()) as unknown as Row | undefined;
  if (!order) return reply.type('text/html; charset=UTF-8').send('');
  // SAFETY: rows are full os_grant_orderdetail rows (cont. pattern).
  const details = (await db
    .selectFrom('os_grant_orderdetail')
    .selectAll()
    .where('orderId', '=', order.orderId as string)
    .execute()) as unknown as Row[];
  // os_trackings is not in the generated Kysely types -> raw SQL.
  const trackings = (await sql`select * from os_trackings where orderId = ${order.orderId}`.execute(db))
    .rows as Row[];
  const out: Row = { ...order };
  out.detail = details;
  out.tracking = trackings;
  reply.send(out);
}

export function registerFollowUpsRoutes(app: FastifyInstance): void {
  resource(app, '/FollowUps', {
    index,
    create,
    store,
    show,
    edit,
    update,
    destroy,
  }, { roles: ROLES });
  any(app, { path: '/FollowUps.show', name: 'FollowUps.show', roles: ROLES, handler: show });
  any(app, { path: '/FollowUps.store', name: 'FollowUps.store', roles: ROLES, handler: store });
  any(app, { path: '/FollowUps.update', name: 'FollowUps.update', roles: ROLES, handler: update });
  any(app, { path: '/FollowUps.updateFollowUp', name: 'FollowUps.updateFollowUp', roles: ROLES, handler: updateFollowUp });
  any(app, { path: '/FollowUps.destroy', name: 'FollowUps.destroy', roles: ROLES, handler: destroy });
  any(app, { path: '/FollowUps.findOrder', name: 'FollowUps.findOrder', roles: ROLES, handler: findCustomerByOrderId });
  any(app, { path: '/FollowUps.ajax', name: 'FollowUps.ajax', roles: ROLES, handler: ajaxindex });
  any(app, { path: '/FollowUps.updateTracking', name: 'FollowUps.updateTracking', roles: ROLES, handler: updateTracking });
}
