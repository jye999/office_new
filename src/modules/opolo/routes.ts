// OpoloController (routes/web.php:65-68, role:admin,user,opolo) and
// OpoloCostController (web.php:388-396, role:admin,user,remote).
// No $hidden/$appends on GrantOrder/GrantOrderDetail/OpoloCost, so a
// serialised model is every DB column.
// Quirks kept (NOTES.md): /manage-opolo and the missing resource methods
// (opolo create/show/edit/update, opolocost create/edit) 500 on the old app's
// "Call to undefined method" — sendServer500 (T10 pattern); opolo/index
// renders `$order->zipcode` (the column is `zip`) so the Zipcode cell is
// always empty; the opolo `detail` relation matches on orderId only (no store
// filter).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { allInput, input, lredirect } from '../../http.js';
import { any, resource, route } from '../../router.js';
import { datatables } from '../../datatables.js';
import { render, sendServer500, url } from '../../view.js';

type Row = Record<string, unknown>;

// response()->json(x) — JSON content type even for values Fastify would send
// as text (same note as T13's jsonValue).
function jsonValue(reply: FastifyReply, value: unknown, status = 200): void {
  reply.code(status).type('application/json; charset=utf-8').send(JSON.stringify(value));
}

// Laravel validation (AJAX callers send Accept: application/json via jQuery
// dataType:'json') -> 422 + { message: <first error>, errors: { field: [msgs] } }.
function validationError(reply: FastifyReply, errors: Record<string, string[]>): void {
  const first = Object.values(errors)[0]?.[0] ?? '';
  jsonValue(reply, { message: first, errors }, 422);
}

// PHP str_getcsv($line) defaults (delimiter ',', enclosure '"', escape '\\'),
// one line at a time (file() already split on \n; a trailing \r stays in the
// last field, like PHP). Trailing empty fields are dropped (PHP behaviour).
// shortcut: rare enclosure edge cases (escape char outside quotes) are not
// exercised by the app's order CSVs.
function strGetCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '\\') {
        cur += line[++i] ?? '';
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// Ajaxis::BtDeleting($title, $body, $link): BootstrapDeleteConfirmationMessage
// head + body + footer (vendor/amranidev/ajaxis resources/views/bootstrap/get).
// Blade {{ }} escapes like Laravel e() (ENT_QUOTES).
function e(s: unknown): string {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function ajaxisBtDeleting(title: string, body: string, link: string): string {
  const head =
    '<div class="modal-dialog" role="document">\n' +
    '    <div class="modal-content">\n' +
    '        <div class="modal-header">\n' +
    '            <button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button>\n' +
    `        <h4 class="modal-title" id="myModalLabel">${e(title)}</h4></div>\n` +
    '        <div class="modal-body">';
  const modalBody = `<div class="modal-body">${body}</div>`;
  const footer =
    '</div>\n' +
    '<div class="modal-footer">\n' +
    '    <button type="button" class="btn btn-default" data-dismiss="modal">Close</button>\n' +
    `    <button type="button" class="destroy btn btn-primary" data-link = "${e(link)}">Agree</button>\n` +
    '</div></div></div>';
  return head + modalBody + footer;
}

// codegen types os_opolo_cost.date/description/cost as NOT NULL, but the
// old app can insert nulls (strict-mode failure = 500 in both apps, like PHP).
function dbStr(v: unknown): never {
  // SAFETY: nulls are deliberate (see above); the cast silences the NOT NULL typing.
  return (v !== null && v !== undefined ? String(v) : null) as unknown as never;
}

// PHP is_numeric().
function numericInput(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'number') return Number.isFinite(v);
  return /^[-+]?[0-9]*\.?[0-9]+$/.test(String(v));
}

// ---------------------------------------------------------------- OpoloController

// index(): store='O'; ?status=processed -> status not null and not '',
// else status is null. detail/tracking eager/loaded per the view.
async function opoloIndex(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const status = input(req, 'status');
  const processed = status !== null && status === 'processed';
  const orders = await db
    .selectFrom('os_grant_order')
    .selectAll()
    .where('store', '=', 'O')
    .where('status', processed ? 'is not' : 'is', null)
    .$if(processed, (q) => q.where('status', '<>', ''))
    .orderBy('created_at', 'desc')
    .execute();
  // with('detail') -> one query on orderId only (the relation has no store filter).
  const ids = orders.map((o) => o.orderId);
  const details = ids.length
    ? await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', ids).execute()
    : [];
  // $order->tracking lazy loads in the view (os_trackings by orderId).
  const trackings = ids.length ? await db.selectFrom('os_trackings').selectAll().where('orderId', 'in', ids).execute() : [];
  const detailBy = new Map<string, Row[]>();
  for (const d of details) (detailBy.get(d.orderId) ?? detailBy.set(d.orderId, []).get(d.orderId)!).push(d as Row);
  const trackingBy = new Map<string, Row[]>();
  for (const t of trackings) (trackingBy.get(t.orderId) ?? trackingBy.set(t.orderId, []).get(t.orderId)!).push(t as Row);
  const viewOrders = orders.map((o) => ({
    ...(o as Row),
    detail: detailBy.get(o.orderId) ?? [],
    tracking: trackingBy.get(o.orderId) ?? [],
  }));
  await render(req, reply, 'opolo/index', { orders: viewOrders, status });
}

// store(): CSV upload (ordersfile). Inserts unseen grant_order rows and
// grant_orderdetail rows for store 'O'; always redirects to opolo.index.
async function opoloStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // $request->hasFile('ordersfile')
  let filename = '';
  let buffer: Buffer | null = null;
  for await (const part of req.files()) {
    if (part.fieldname !== 'ordersfile') continue;
    filename = part.filename;
    buffer = await part.toBuffer();
  }
  if (filename && buffer) {
    // pathinfo($getClientOriginalName())['extension']
    const ext = filename.split('.').pop()?.toUpperCase() ?? '';
    if (ext === 'CSV') {
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i === 0) continue;
        const o = strGetCsv(lines[i]);
        if (o.length === 0) continue;
        const orderId = o[1] ?? null;
        const oldOrder = await db
          .selectFrom('os_grant_order')
          .select('id')
          .where('orderId', '=', String(orderId))
          .where('store', '=', 'O')
          .executeTakeFirst();
        if (!oldOrder) {
          const ts = nowDb();
          await db
            .insertInto('os_grant_order')
            .values({
              store: 'O',
              orderId: String(orderId ?? ''),
              purchaseDate: o[0] ?? null,
              recipientName: o[2] ?? null,
              address1: o[3] ?? null,
              address2: o[4] ?? null,
              city: o[5] ?? null,
              state: o[6] ?? null,
              zip: o[7] ?? null,
              country: o[8] ?? null,
              // SAFETY: nowDb() returns 'YYYY-MM-DD HH:mm:ss' strings (Eloquent timestamps).
              created_at: ts as unknown as never, // SAFETY: same string-timestamp cast.
              updated_at: ts as unknown as never, // SAFETY: same string-timestamp cast.
            })
            .execute();
        }
        const asin = o[11] ?? null;
        const oldDetail = await db
          .selectFrom('os_grant_orderdetail')
          .select('id')
          .where('orderId', '=', String(orderId))
          .where('store', '=', 'O')
          .where('asin', '=', String(asin))
          .executeTakeFirst();
        if (!oldDetail) {
          const ts = nowDb();
          await db
            .insertInto('os_grant_orderdetail')
            .values({
              store: 'O',
              orderId: String(orderId ?? ''),
              // isset($o[12]) ? $o[12] : $o[11] — isset is false for missing keys.
              itemId: o[12] !== undefined ? String(o[12]) : String(asin ?? ''),
              asin: String(asin ?? ''),
              // SAFETY: CSV cells arrive as strings; MySQL casts them to the int column like PDO did.
              qty: (o[10] !== undefined ? o[10] : null) as unknown as never,
              name: o[9] ?? null,
              // SAFETY: nowDb() returns 'YYYY-MM-DD HH:mm:ss' strings (Eloquent timestamps).
              created_at: ts as unknown as never, // SAFETY: same string-timestamp cast.
              updated_at: ts as unknown as never, // SAFETY: same string-timestamp cast.
            })
            .execute();
        }
      }
    }
  }
  lredirect(req, reply, '/opolo.index');
}

// destroy(): the {id} param is the orderId (string), not the row id.
async function opoloDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = String((req.params as { id: string }).id);
  await db.deleteFrom('os_grant_orderdetail').where('store', '=', 'O').where('orderId', '=', id).execute();
  await db.deleteFrom('os_grant_order').where('store', '=', 'O').where('orderId', '=', id).execute();
  reply.type('text/html; charset=UTF-8').send(url('opolo.index'));
}

// DeleteMsg(): Ajaxis modal HTML for ajax requests; non-ajax returns null.
async function opoloDeleteMsg(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const msg = ajaxisBtDeleting('Warning!!', 'Would you like to remove This?', `/opolo/${(req.params as { id: string }).id}/delete`);
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    reply.type('text/html; charset=UTF-8').send(msg);
  }
}

// ---------------------------------------------------------------- OpoloCostController

async function opolocostShow(req: FastifyRequest, reply: FastifyReply, paramId?: string): Promise<void> {
  // show(Request $request, $id = 0): the /opolocost.show routes carry no {id},
  // so the id comes from the query/body.
  const raw = paramId ?? 0;
  const fromQuery = Number(input(req, 'id') ?? 0); // missing/null -> 0 -> no row -> 404, like findOrFail(null)
  const id = raw === 0 || raw === '' || raw === '0' ? fromQuery : Number(raw);
  const row = await db.selectFrom('os_opolo_cost').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw Object.assign(new Error('OpoloCost not found'), { statusCode: 404 }); // findOrFail
  reply.send(row as Row);
}

// Laravel rules: date required; cost Numeric.
function opolocostValidate(req: FastifyRequest): Record<string, string[]> {
  const all = allInput(req);
  const errors: Record<string, string[]> = {};
  const date = all['date'];
  if (date === null || date === undefined || date === '' || (Array.isArray(date) && date.length === 0)) {
    errors['date'] = ['The date field is required.'];
  }
  const cost = all['cost'];
  if (cost !== null && cost !== undefined && cost !== '' && !numericInput(cost)) {
    errors['cost'] = ['The cost must be a number.'];
  }
  return errors;
}

async function opolocostStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const storeErrors = opolocostValidate(req);
  if (Object.keys(storeErrors).length) return validationError(reply, storeErrors);
  // OpoloCost::create($request->all()) — only $fillable date/description/category/cost.
  const all = allInput(req);
  const ts = nowDb();
  // Eloquent create($request->all()): only the keys PRESENT in the request are
  // mass-assigned (a missing key is simply not in the INSERT).
  const values: Record<string, unknown> = {};
  for (const k of ['date', 'description', 'category', 'cost']) {
    if (all[k] !== undefined) values[k] = dbStr(all[k]);
  }
  // SAFETY: values/timestamps are runtime-built (see above); Kysely cannot type the dynamic shape.
  const insertValues = { ...values, created_at: ts, updated_at: ts } as never;
  const result = await db.insertInto('os_opolo_cost').values(insertValues).executeTakeFirst();
  // response()->json($create) — the fresh model, all columns in DB order.
  const row = await db.selectFrom('os_opolo_cost').selectAll().where('id', '=', Number(result?.insertId)).executeTakeFirst();
  jsonValue(reply, row as Row);
}

async function opolocostUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const updateErrors = opolocostValidate(req);
  if (Object.keys(updateErrors).length) return validationError(reply, updateErrors);
  const all = allInput(req);
  const id = input(req, 'id');
  const found = await db.selectFrom('os_opolo_cost').select('id').where('id', '=', Number(id)).executeTakeFirst();
  if (!found) throw new Error('Call to a member function update() on null'); // PHP fatal -> 500
  // Eloquent update: only fillable date/description/category/cost, as sent.
  const ts = nowDb();
  const set: Record<string, unknown> = {};
  for (const k of ['date', 'description', 'category', 'cost']) {
    if (all[k] !== undefined) set[k] = dbStr(all[k]);
  }
  // SAFETY: nowDb() 'YYYY-MM-DD HH:mm:ss' string (Eloquent timestamps).
  set['updated_at'] = ts as unknown as never;
  await db.updateTable('os_opolo_cost').set(set).where('id', '=', Number(id)).execute();
  jsonValue(reply, 1);
}

async function opolocostDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = input(req, 'id');
  const found = await db.selectFrom('os_opolo_cost').select('id').where('id', '=', Number(id)).executeTakeFirst();
  if (!found) throw new Error('Call to a member function delete() on null'); // PHP fatal -> 500
  await db.deleteFrom('os_opolo_cost').where('id', '=', Number(id)).execute();
  jsonValue(reply, ['done']);
}

async function opolocostAjaxData(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await datatables(db.selectFrom('os_opolo_cost').selectAll())
    .addColumn('action', (o) =>
      '<button class="btn btn-info btn-xs btnEdit" value="' + o['id'] + '">\n' +
      '                <span class="glyphicon glyphicon-pencil"></span></button>\n' +
      '                <button class="btn btn-danger btn-xs btnDelete" value="' + o['id'] + '">\n' +
      '                <span class="glyphicon glyphicon-trash"></span></button>',
    )
    .editColumn('id', 'ID: {{$id}}')
    .make(allInput(req));
  reply.send(result);
}

// ---------------------------------------------------------------- registration

export function registerOpoloRoutes(app: FastifyInstance): void {
  const opoloRoles = ['admin', 'user', 'opolo'];
  const costRoles = ['admin', 'user', 'remote'];

  // Route::resource('opolo', OpoloController) — the controller has only
  // index/store/destroy; missing methods 500 like the old app (T10 pattern).
  resource(app, '/opolo', {
    index: opoloIndex,
    create: async (_req, reply) => sendServer500(_req, reply),
    store: opoloStore,
    show: async (_req, reply) => sendServer500(_req, reply),
    edit: async (_req, reply) => sendServer500(_req, reply),
    update: async (_req, reply) => sendServer500(_req, reply),
    destroy: opoloDestroy,
  }, { roles: opoloRoles });

  // Later registration wins: opolo.index points at /opolo.index (not /opolo).
  route(app, {
    verb: 'get',
    path: '/opolo.index',
    name: 'opolo.index',
    roles: opoloRoles,
    handler: opoloIndex,
  });
  route(app, {
    verb: 'get',
    path: '/opolo/{id}/delete',
    roles: opoloRoles,
    handler: opoloDestroy,
  });
  route(app, {
    verb: 'get',
    path: '/opolo/{id}/deleteMsg',
    roles: opoloRoles,
    handler: opoloDeleteMsg,
  });

  // Route::get('manage-opolo', OpoloCostController@manageOpolo) — no such
  // method exists, so it always 500s (Call to undefined method).
  route(app, {
    verb: 'get',
    path: '/manage-opolo',
    roles: costRoles,
    handler: async (req, reply) => sendServer500(req, reply),
  });

  // Route::resource('opolocost', ...) (registered twice in web.php — identical).
  resource(app, '/opolocost', {
    index: async (req, reply) => render(req, reply, 'opolocost/index'),
    create: async (_req, reply) => sendServer500(_req, reply),
    store: opolocostStore,
    show: (req, reply) => opolocostShow(req, reply, String((req.params as { id: string }).id)),
    edit: async (_req, reply) => sendServer500(_req, reply),
    update: opolocostUpdate,
    destroy: opolocostDestroy,
  }, { roles: costRoles });

  any(app, { path: '/opolocost.show', name: 'opolocost.show', roles: costRoles, handler: (req, reply) => opolocostShow(req, reply) });
  any(app, { path: '/opolocost.store', name: 'opolocost.store', roles: costRoles, handler: opolocostStore });
  any(app, { path: '/opolocost.update', name: 'opolocost.update', roles: costRoles, handler: opolocostUpdate });
  any(app, { path: '/opolocost.destroy', name: 'opolocost.destroy', roles: costRoles, handler: opolocostDestroy });
  route(app, { verb: 'get', path: '/opolocost.ajaxData', name: 'opolocost.ajaxData', roles: costRoles, handler: opolocostAjaxData });
}

