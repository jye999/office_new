// InventoryController (routes/web.php:363-378; all role:admin,user,remote).
// T25a scope: inventory/inv pages, anyData, create/update/delete, dataResponse
// (DatatablesEditor), quickUpdate, findLocations. The *Transfer routes and
// consolidation belong to T25b.
//
// Models: Inventory (os_inventory, no $hidden/$appends/$casts, timestamps on),
// ProductLocation (os_product_locations, same), Product (os_products — only
// its id/sku are used here, never serialized).
//
// Quirks: the routes are both named 'inventory' (Laravel last-registration
// wins -> route('inventory') = /inv); anyData 500s when `filter` is absent or
// a key is missing (PHP notice/warning -> HandleExceptions -> ErrorException)
// and applies the filter values RAW (no % wildcards); dataResponse's Builder
// source scopes get() to id<=50 but the static find() used by edit/remove is
// unscoped; create always 500s (qty NOT NULL, controller never assigns it).

import type { FastifyInstance } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { input, allInput } from '../../http.js';
import { datatables } from '../../datatables.js';
import { route, any } from '../../router.js';
import { render, phpEmpty } from '../../view.js';
import {
  datatablesEditorProcess,
  type EditorModelSource,
  type EditorValidator,
} from '../../lib/datatables-editor.js';
import { mergeDuplicateLocations, ensureDefaultStillStocked } from '../../lib/warehouseLocation.js';

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

// ---------------------------------------------------------------- page routes

function currentLocation(req: Parameters<typeof render>[0]): string {
  // $request->has('location') -> $request->location (has = key present, even empty).
  const loc = input(req, 'location');
  return loc === null ? 'AI' : String(loc);
}

const inventoryPage = async (req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> => {
  await render(req, reply, 'inventory/index', { title: 'inventory', currentLocation: currentLocation(req) });
};

const invPage = async (req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> => {
  await render(req, reply, 'inventory/inv', { title: 'inventory', currentLocation: currentLocation(req) });
};

// ---------------------------------------------------------------- anyData

// PHP loose `$x != ""` is false only for '', '0', 0, false, [].
function phpLooseNotEqEmpty(v: unknown): boolean {
  return !(v === '' || v === '0' || v === 0 || v === false || (Array.isArray(v) && v.length === 0));
}

async function anyData(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const location = input(req, 'location');
  // Kysely `= null` -> `is null` (Laravel QueryBuilder does the same).
  let q = db.selectFrom('os_inventory').selectAll().where('location', '=', location as never);
  // PHP: $request->filter["name"] on an absent / non-object filter (or a
  // missing key) is a warning/notice that Laravel's HandleExceptions turns
  // into an ErrorException -> 500. The real UI always sends all four keys.
  const filter = input(req, 'filter');
  const FILTER_KEYS = ['name', 'color', 'vendor_sku', 'sku'];
  if (!filter || typeof filter !== 'object' || Array.isArray(filter) || !FILTER_KEYS.every((k) => k in filter)) {
    throw new Error('filter parameter missing'); // -> 500, like the old app
  }
  for (const k of FILTER_KEYS) {
    const v = (filter as Record<string, unknown>)[k];
    // if($request->filter["name"] != "") — raw value, no % wildcards.
    if (typeof v === 'string' && phpLooseNotEqEmpty(v)) q = q.where(k as never, 'like', v as never);
  }
  const result = await datatables(q).make(allInput(req));
  reply.send(result.data);
}

// ---------------------------------------------------------------- CRUD

// 'location','qty','sku','name','color','status'
const INV_FIELDS = ['sku', 'name', 'location', 'vendor_sku', 'color', 'status'] as const;

async function create(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const all = allInput(req);
  const set: Record<string, unknown> = {};
  for (const k of INV_FIELDS) if (k in all) set[k] = all[k];
  const now = nowDb();
  // SAFETY: runtime values are plain strings/numbers (timestamps are
  // 'YYYY-MM-DD HH:mm:ss', dateStrings T00); kysely's InsertObject typing is
  // stricter than the runtime contract (same pattern as followups/routes.ts).
  const values: Record<string, unknown> = { ...set, created_at: now, updated_at: now };
  // MySQL has no RETURNING — insertId from the result packet (followups pattern).
  const ins = await db.insertInto('os_inventory').values(values as never).executeTakeFirst();
  // Model serialises the set attributes + id + timestamps (insertion order).
  const out: Record<string, unknown> = {};
  for (const k of INV_FIELDS) if (k in set) out[k] = set[k];
  out.id = Number(ins?.insertId);
  out.created_at = now;
  out.updated_at = now;
  reply.send(out);
}

async function update(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const id = input(req, 'id');
  const inv =
    id === null
      ? null
      : await db.selectFrom('os_inventory').selectAll().where('id', '=', Number(id)).executeTakeFirst();
  if (!inv) return reply.status(200).send(''); // return null -> empty 200
  const all = allInput(req);
  const set: Record<string, unknown> = {};
  for (const k of INV_FIELDS) if (k in all) set[k] = all[k];
  const now = nowDb();
  const upd: Record<string, unknown> = { ...set, updated_at: now };
  await db.updateTable('os_inventory').set(upd).where('id', '=', inv.id).execute();
  reply.send({ ...inv, ...set, updated_at: now });
}

async function delete_(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const id = input(req, 'id');
  const inv =
    id === null
      ? null
      : await db.selectFrom('os_inventory').select('id').where('id', '=', Number(id)).executeTakeFirst();
  if (inv) await db.deleteFrom('os_inventory').where('id', '=', inv.id).execute();
  reply.status(200).send(''); // no return statement -> empty 200
}

// ---------------------------------------------------------------- dataResponse (DatatablesEditor)

// Laravel Validator::make($data, {sku,name: 'required'}) + the custom messages.
function dataResponseValidator(first: Record<string, unknown> | undefined): EditorValidator {
  const errors: Record<string, string[]> = {};
  // 'required' fails on missing/null/'' (0 passes).
  const fails = (v: unknown) => v === undefined || v === null || v === '';
  if (fails(first?.sku)) errors['sku'] = ['Please provide sku name.'];
  if (fails(first?.name)) errors['name'] = ['Please provide name.'];
  return { fails: () => Object.keys(errors).length > 0, errors: () => errors };
}

// Inventory::where('id','<=',50) is an Eloquent Builder: PHP reduces it to
// get()[0], so create() crashes (null->create); edit/remove call the STATIC
// find() (unscoped) on that model instance.
function inventoryBuilderSource(): EditorModelSource {
  return {
    all: async () => {
      const rows = await db.selectFrom('os_inventory').selectAll().where('id', '<=', 50).execute();
      return rows.map(() => ({
        create: async () => {
          throw new Error('Call to a member function create() on null');
        },
        update: async () => {},
        delete: async () => {},
      }));
    },
    find: async (id) => {
      const first = await db.selectFrom('os_inventory').select('id').where('id', '<=', 50).executeTakeFirst();
      if (!first) throw new Error('Call to a member function find() on null');
      const row = await db.selectFrom('os_inventory').select('id').where('id', '=', Number(id)).executeTakeFirst();
      if (!row) return null;
      return {
        update: async (data) => {
          const upd: Record<string, unknown> = { ...data, updated_at: nowDb() };
          await db.updateTable('os_inventory').set(upd).where('id', '=', row.id).execute();
        },
        delete: async () => {
          await db.deleteFrom('os_inventory').where('id', '=', row.id).execute();
        },
      };
    },
  };
}

async function dataResponse(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const all = allInput(req);
  const data = all['data'];
  // PHP: array_keys($input['data']) on null + Validator::make(null, ...) ->
  // TypeError -> 500 whenever `data` is not an object.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError("Validator::make(): Argument #1 ($data) must be of type array, null given");
  }
  const dataObj = data as Record<string, Record<string, unknown>>;
  const rowFirstId = Object.keys(dataObj)[0];
  const result = await datatablesEditorProcess(
    { action: String(input(req, 'action') ?? '') as 'edit', data: dataObj },
    dataResponseValidator(dataObj[rowFirstId]),
    inventoryBuilderSource(),
  );
  reply.status(result.status).send(result.body);
}

// ---------------------------------------------------------------- quickUpdate / findLocations

// PHP (int) cast: leading numeric prefix, ''/garbage -> 0.
function phpIntCast(v: unknown): number {
  const s = String(v).trim();
  const m = /^[-+]?(\d+)(?:\.\d+)?/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

// Laravel 'numeric' = PHP is_numeric (whitespace-tolerant numeric string/number).
function laravelNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && !Number.isNaN(Number(v));
  return false;
}

const requiredMsg = (field: string) => `The ${field} field is required.`;

async function quickUpdate(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const all = allInput(req);
  const sku = all['sku'];
  const location = all['location'];
  const qty = all['qty'];
  // sku/location 'required|string'; qty 'required|numeric|min:0' (field order).
  const errors: Record<string, string[]> = {};
  if (sku === undefined || sku === null || sku === '') errors['sku'] = [requiredMsg('sku')];
  else if (typeof sku !== 'string') errors['sku'] = ['The sku field must be a string.'];
  if (location === undefined || location === null || location === '') errors['location'] = [requiredMsg('location')];
  else if (typeof location !== 'string') errors['location'] = ['The location field must be a string.'];
  if (qty === undefined || qty === null || qty === '') errors['qty'] = [requiredMsg('qty')];
  else if (!laravelNumeric(qty)) errors['qty'] = ['The qty field must be a number.'];
  else if (Number(qty) < 0) errors['qty'] = ['The qty field must be at least 0.'];
  if (Object.keys(errors).length) {
    return reply.code(422).send({ success: false, message: 'Validation failed: ' + Object.values(errors)[0][0] });
  }

  const product = await db.selectFrom('os_products').selectAll().where('sku', '=', String(sku)).executeTakeFirst();
  if (!product) return reply.code(404).send({ success: false, message: 'SKU not found.' });
  await mergeDuplicateLocations(product.id);
  const locNorm = String(location).trim().toUpperCase();
  const pl = await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', product.id)
    .where(sql<boolean>`UPPER(TRIM(location)) = ${locNorm}`)
    .executeTakeFirst();
  const now = nowDb();
  if (pl) {
    const upd: Record<string, unknown> = { qty, location: locNorm, updated_at: now };
    await db.updateTable('os_product_locations').set(upd).where('id', '=', pl.id).execute();
  } else {
    // SAFETY: plain column values (qty may be a numeric string, as PHP sends it).
    const values: Record<string, unknown> = {
      product_id: product.id,
      location: locNorm,
      qty,
      created_at: now,
      updated_at: now,
    };
    await db.insertInto('os_product_locations').values(values as never).execute();
  }
  if (phpIntCast(qty) <= 0) await ensureDefaultStillStocked(product.id);

  const locs = await db
    .selectFrom('os_product_locations')
    .select(['location', 'qty'])
    .where('product_id', '=', product.id)
    .orderBy('location')
    .execute();
  reply.send({
    success: true,
    sku: sku,
    locations: locs.map((l) => ({ location: l.location, qty: l.qty })),
    message: 'Inventory updated successfully.',
  });
}

async function findLocations(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const sku = input(req, 'sku');
  // PHP: if (!$request->has('sku') || empty($request->input('sku')))
  if (sku === null || phpEmpty(sku)) {
    return reply.code(422).send({ success: false, message: 'SKU is required.' });
  }
  const products = await db.selectFrom('os_products').selectAll().where('sku', 'like', String(sku) + '%').execute();
  if (products.length === 0) {
    return reply.code(404).send({ success: false, message: 'No SKU found matching the pattern.' });
  }
  const allLocations: Record<string, unknown>[] = [];
  for (const product of products) {
    await mergeDuplicateLocations(product.id);
    const pls = await db
      .selectFrom('os_product_locations')
      .select(['location', 'qty'])
      .where('product_id', '=', product.id)
      .orderBy('location')
      .execute();
    for (const l of pls) allLocations.push({ sku: product.sku, location: l.location, qty: l.qty });
  }
  reply.send({ success: true, locations: allLocations, message: 'Locations retrieved successfully.' });
}

// ---------------------------------------------------------------- registration

export function registerInventoryRoutes(app: FastifyInstance): void {
  // web.php registers both GET routes under the name 'inventory'; the later
  // one wins the named-route table (Laravel behaviour, kept).
  route(app, { verb: 'get', path: '/inventory', name: 'inventory', middleware: MIDDLEWARE, handler: inventoryPage });
  route(app, { verb: 'get', path: '/inv', name: 'inventory', middleware: MIDDLEWARE, handler: invPage });
  any(app, { path: '/inventory.data', name: 'inventory.data', middleware: MIDDLEWARE, handler: anyData });
  route(app, { verb: 'put', path: '/inventory.create', name: 'inventory.create', middleware: MIDDLEWARE, handler: create });
  route(app, { verb: 'post', path: '/inventory.update', name: 'inventory.update', middleware: MIDDLEWARE, handler: update });
  route(app, { verb: 'delete', path: '/inventory.delete', name: 'inventory.delete', middleware: MIDDLEWARE, handler: delete_ });
  any(app, { path: '/inventory.response', name: 'inventory.response', middleware: MIDDLEWARE, handler: dataResponse });
  route(app, { verb: 'post', path: '/inventory.quickUpdate', name: 'inventory.quickUpdate', middleware: MIDDLEWARE, handler: quickUpdate });
  route(app, { verb: 'get', path: '/inventory.findLocations', name: 'inventory.findLocations', middleware: MIDDLEWARE, handler: findLocations });
}
