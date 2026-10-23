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
import {
  mergeDuplicateLocations,
  mergeAllDuplicateLocations,
  ensureDefaultStillStocked,
  recommend,
  type ClusterRow,
} from '../../lib/warehouseLocation.js';

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

// ---------------------------------------------------------------- T25b: transfers (web.php:371-376) + consolidation (web.php:461-462)
// Model InventoryTransfer (os_inventory_transfer, no $hidden/$appends/$casts,
// timestamps on). Fields assigned in the controller's has() check order.
const TRANSFER_FIELDS = [
  'from_location',
  'to_location',
  'sku',
  'qty',
  'status',
  'received',
  'checked_by',
  'notes',
  'received_date',
  'expected_date',
  'tracking',
] as const;

// PHP SUM() returns null for an empty set; null arithmetic is 0-based.
function sumOrNull(rows: { s: number | null }[]): number | null {
  return rows[0]?.s ?? null;
}

async function transferSum(
  k: typeof db,
  sku: unknown,
  locCol: 'from_location' | 'to_location',
  locVal: unknown,
  statuses?: string[],
  sumCol: 'qty' | 'received' = 'qty',
): Promise<number | null> {
  let q = k
    .selectFrom('os_inventory_transfer')
    .select(sql<number | null>`sum(${sql.ref(sumCol)})`.as('s'))
    .where('sku', '=', sku as never)
    // Laravel where(col, '=', null) -> "is null"; `1 = 0` is the same empty set for SUM.
    .where(locVal === null ? sql<boolean>`1 = 0` : sql<boolean>`${sql.ref(locCol)} = ${String(locVal)}`);
  if (statuses) q = q.where('status', 'in', statuses);
  return sumOrNull(await q.execute());
}

// Port of InventoryController::recalculateInventory (PHP sets from_inv/to_inv
// qty = transfer sums, pending_qty, and inserts a missing Inventory row).
async function recalculateInventory(req: Parameters<typeof input>[0], k: typeof db = db): Promise<void> {
  const sku = input(req, 'sku');
  const from = input(req, 'from_location');
  const to = input(req, 'to_location');

  // PHP conditions copied line-for-line (which column is compared differs per sum).
  const pendingTransferIn = await transferSum(k, sku, 'to_location', to, ['Pending']);
  const fromTransferIn = await transferSum(k, sku, 'to_location', from, ['Completed', 'OnRoute'], 'received');
  const fromTransferOut = await transferSum(k, sku, 'from_location', from, ['Completed', 'OnRoute']);
  const toTransferIn = await transferSum(k, sku, 'to_location', to, undefined, 'received');
  const toTransferOut = await transferSum(k, sku, 'from_location', to);
  const n = (v: number | null) => v ?? 0;

  interface InvShape {
    id: number;
    name: string | null;
    color: string | null;
    vendor_sku: string | null;
    sku: string | null;
  }
  const invRow = async (loc: unknown): Promise<InvShape | null> => {
    if (loc === null) return null;
    const row = await k
      .selectFrom('os_inventory')
      .select(['id', 'name', 'color', 'vendor_sku', 'sku'])
      .where('sku', '=', sku as never)
      .where('location', '=', loc as never)
      .executeTakeFirst();
    return row ?? null;
  };
  let fromInv = await invRow(from);
  const toInv = await invRow(to);

  const now = nowDb();
  if (fromInv) {
    await k
      .updateTable('os_inventory')
      .set({ qty: n(fromTransferIn) - n(fromTransferOut), updated_at: now as never })
      .where('id', '=', fromInv.id)
      .execute();
  } else if (toInv && from !== 'New') {
    const values: Record<string, unknown> = {
      name: toInv.name,
      color: toInv.color,
      vendor_sku: toInv.vendor_sku,
      location: from,
      sku: toInv.sku,
      qty: n(fromTransferIn) - n(fromTransferOut),
      created_at: now,
      updated_at: now,
    };
    await k.insertInto('os_inventory').values(values as never).execute();
    // PHP reuses the local var: the new row counts as from_inv below.
    fromInv = { id: -1, name: toInv.name, color: toInv.color, vendor_sku: toInv.vendor_sku, sku: toInv.sku };
  }
  if (toInv) {
    await k
      .updateTable('os_inventory')
      .set({ qty: n(toTransferIn) - n(toTransferOut), pending_qty: pendingTransferIn, updated_at: now as never })
      .where('id', '=', toInv.id)
      .execute();
  } else if (fromInv) {
    const values: Record<string, unknown> = {
      name: fromInv.name,
      color: fromInv.color,
      vendor_sku: fromInv.vendor_sku,
      sku: fromInv.sku,
      location: to,
      pending_qty: pendingTransferIn,
      qty: n(toTransferIn) - n(toTransferOut),
      created_at: now,
      updated_at: now,
    };
    await k.insertInto('os_inventory').values(values as never).execute();
  }
}

// $request->has('from_location') style field assignment (has = key present, value may be null).
function transferSet(req: Parameters<typeof input>[0]): Record<string, unknown> {
  const all = allInput(req);
  const set: Record<string, unknown> = {};
  for (const f of TRANSFER_FIELDS) if (f in all) set[f] = all[f];
  return set;
}

async function createTransfer(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const set = transferSet(req);
  const now = nowDb();
  // SAFETY: kysely InsertObject typing is stricter than the runtime contract.
  const values: Record<string, unknown> = { ...set, created_at: now, updated_at: now };
  const ins = await db.insertInto('os_inventory_transfer').values(values as never).executeTakeFirst();
  const out: Record<string, unknown> = { ...set, created_at: now, updated_at: now };
  out.id = Number(ins?.insertId);
  await recalculateInventory(req);
  reply.send(out);
}

async function updateTransfer(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const id = input(req, 'id');
  const inv =
    id === null
      ? null
      : await db.selectFrom('os_inventory_transfer').selectAll().where('id', '=', Number(id)).executeTakeFirst();
  if (!inv) return reply.status(200).send(''); // return null -> empty 200
  const set = transferSet(req);
  // PHP `$inv->from_location==$inv->to_location` (loose ==; null == null).
  const cur: Record<string, unknown> = { ...inv, ...set };
  if (cur['from_location'] == cur['to_location']) {
    return reply.code(500).send('from and to locations cannot be the same');
  }
  const now = nowDb();
  const upd: Record<string, unknown> = { ...set, updated_at: now };
  await db.updateTable('os_inventory_transfer').set(upd as never).where('id', '=', inv.id).execute();
  await recalculateInventory(req);
  reply.send({ ...inv, ...set, updated_at: now });
}

// uploadTransfer: find($id) + an empty if-block, then return null. No writes.
// (the multipart body is never read by the PHP controller either).
async function uploadTransfer(_req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  reply.status(200).send('');
}

async function deleteTransfer(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const id = input(req, 'id');
  const inv =
    id === null
      ? null
      : await db.selectFrom('os_inventory_transfer').select('id').where('id', '=', Number(id)).executeTakeFirst();
  if (inv) await db.deleteFrom('os_inventory_transfer').where('id', '=', inv.id).execute();
  await recalculateInventory(req);
  reply.status(200).send(''); // no return statement -> empty 200
}

async function transferData(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const location = input(req, 'location');
  // Laravel where(col, '=', null) -> "col is null"; the two where()s are OR-ed
  // inside one group (PHP where(fn) with ->orWhere).
  // SAFETY: the raw OR-group is parenthesized — Kysely 0.29 concatenates a
  // following .where() with AND but does not wrap the raw expression in
  // parentheses, so an unparenthesized OR would bind wrong (T25a found the
  // same flattening; parenthesized it compiles to one grouped expression).
  const base = db
    .selectFrom('os_inventory_transfer')
    .selectAll()
    .where(
      location === null
        ? sql<boolean>`(${sql.ref('to_location')} is null or ${sql.ref('from_location')} is null)`
        : sql<boolean>`(${sql.ref('to_location')} = ${String(location)} or ${sql.ref('from_location')} = ${String(location)})`,
    );
  const cur = input(req, 'currentItem');
  // The PHP runs Debugbar::info($request->currentItem['sku']) BEFORE the
  // has('currentItem') check: missing/non-object currentItem -> warning ->
  // ErrorException -> 500 (verified live on :6999). The has()-guarded query
  // below only runs when currentItem is an object with a sku key.
  if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !('sku' in cur)) {
    throw new Error('currentItem sku missing');
  }
  const skuVal = (cur as Record<string, unknown>)['sku'];
  const q = base.where('sku', '=', (skuVal === null ? null : String(skuVal)) as never);
  const result = await datatables(q).make(allInput(req));
  reply.send(result.data);
}

// ---------------------------------------------------------------- consolidation

// Port of InventoryController::consolidation. Side effect kept: the old app
// merges duplicate location rows (writes) on every GET, before responding.
async function consolidation(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const filterIn = input(req, 'filter');
  const hasFilter = filterIn !== null && phpLooseNotEqEmpty(filterIn);
  const filter = hasFilter ? String(filterIn) : '';

  await mergeAllDuplicateLocations();

  let splitIds = await db
    .selectFrom('os_product_locations')
    .select('product_id')
    .where('qty', '>', 0)
    .where(sql<boolean>`${sql.ref('location')} is not null`)
    .where('location', '!=', '')
    .groupBy('product_id')
    .having(sql.raw('COUNT(*) >= 2') as never)
    .execute();
  if (splitIds.length === 0) return reply.send({ total: 0, items: [] });

  if (filter !== '') {
    // Faithful port of a deterministic old-app 500: orWhereHas('product')
    // inside the nested where closure crashes the Laravel 5.4 framework
    // (compact(): Undefined variable: operator in Query\Builder::
    // addWhereExistsQuery — 'or' is passed positionally into the 5.4
    // ($query, $boolean) signature). Any non-empty filter 500s; verified
    // in the office container log.
    throw Object.assign(new Error('compact(): Undefined variable: operator'), { statusCode: 500 });
  }

  // with('product') = left hasOne; rows without a product are skipped below,
  // so an inner join is equivalent and cheaper.
  const rows = await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', 'in', splitIds.map((r) => r.product_id))
    .where('qty', '>', 0)
    .where(sql<boolean>`${sql.ref('location')} is not null`)
    .where('location', '!=', '')
    .orderBy('location')
    .execute();
  // with('product') — second query for the product skus (rows without a
  // product are skipped below, like PHP's null check).
  const skus = await db
    .selectFrom('os_products')
    .select(['id', 'sku'])
    .where('id', 'in', [...new Set(rows.map((r) => r.product_id).filter((v): v is number => v !== null))])
    .execute();
  const skuById = new Map(skus.map((p) => [p.id, p.sku]));

  // PHP: skip rows whose product or product.sku is null/''.
  const byProduct: Record<number, { product_id: number; sku: string; locations: ClusterRow[] }> = {};
  for (const row of rows) {
    const pid = row.product_id;
    if (pid === null) continue;
    const sku = skuById.get(pid) ?? null;
    if (sku === null || sku === '') continue;
    if (!(pid in byProduct)) byProduct[pid] = { product_id: pid, sku, locations: [] };
    byProduct[pid].locations.push({
      id: row.id,
      location: row.location,
      qty: rowIntCast(row.qty),
      packing: row.packing,
      carton: row.carton,
    });
  }

  const items: Record<string, unknown>[] = [];
  for (const item of Object.values(byProduct)) {
    if (item.locations.length < 2) continue;
    const rec = recommend(item.locations);
    if (rec === null) continue;
    items.push({
      product_id: item.product_id,
      sku: item.sku,
      locations: item.locations,
      clusters: rec.clusters,
      suggested_target: rec.suggested_target,
      suggested_moves: rec.suggested_moves,
    });
  }
  // usort strcasecmp(sku) — JS sort is stable (PHP 7 usort not; ties unlikely).
  items.sort((a, b) => strcasecmpSku(String(a['sku']), String(b['sku'])));
  reply.send({ total: items.length, items });
}

function strcasecmpSku(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    const d = la.charCodeAt(i) - lb.charCodeAt(i);
    if (d !== 0) return d;
  }
  return la.length - lb.length;
}

function rowIntCast(v: unknown): number {
  const s = String(v ?? '').trim();
  const m = /^[-+]?\d+/.exec(s);
  return m ? parseInt(m[0], 10) : 0;
}

// PHP \Exception catch inside the transaction: rollback + 500 'move failed'.
class MoveFailed extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function applyOneConsolidationMove(k: typeof db, productId: number, from: string, to: string, qty: number): Promise<true | MoveFailed> {
  await mergeDuplicateLocations(productId, k);
  // lockForUpdate -> FOR UPDATE.
  const source = await k
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', productId)
    .where(sql<boolean>`UPPER(TRIM(${sql.ref('location')})) = ${from}`)
    .forUpdate()
    .executeTakeFirst();
  if (!source) return new MoveFailed(404, 'source location not found: ' + from);
  if (rowIntCast(source.qty) < qty) return new MoveFailed(422, from + ' does not have enough qty');

  const dest = await k
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', productId)
    .where(sql<boolean>`UPPER(TRIM(${sql.ref('location')})) = ${to}`)
    .forUpdate()
    .executeTakeFirst();

  const now = nowDb();
  if (dest) {
    // Eloquent save() also refreshes updated_at.
    await k
      .updateTable('os_product_locations')
      .set({ qty: rowIntCast(dest.qty) + qty, location: to, countdate: now as never, updated_at: now as never })
      .where('id', '=', dest.id)
      .execute();
  } else {
    const values: Record<string, unknown> = { product_id: productId, location: to, qty, countdate: now, created_at: now, updated_at: now };
    await k.insertInto('os_product_locations').values(values as never).execute();
  }

  const newSourceQty = rowIntCast(source.qty) - qty;
  if (newSourceQty <= 0) {
    await k.deleteFrom('os_product_locations').where('id', '=', source.id).execute();
    await ensureDefaultStillStocked(productId, k);
  } else {
    await k
      .updateTable('os_product_locations')
      .set({ qty: newSourceQty, countdate: now as never, updated_at: now as never })
      .where('id', '=', source.id)
      .execute();
  }
  return true;
}

async function moveConsolidation(req: Parameters<typeof render>[0], reply: Parameters<typeof render>[1]): Promise<void> {
  const sku = String(input(req, 'sku') ?? '').trim();
  const defaultTo = String(input(req, 'to_location') ?? '').trim().toUpperCase();
  if (sku === '') return reply.code(422).send({ message: 'sku is required' });

  const movesIn = input(req, 'moves');
  let moves: unknown[];
  if (!Array.isArray(movesIn) || movesIn.length === 0) {
    // Legacy single-move body: sku, from_location, to_location, qty.
    const from = String(input(req, 'from_location') ?? '').trim().toUpperCase();
    const qty = phpIntCast(input(req, 'qty') ?? '');
    if (from === '') return reply.code(422).send({ message: 'from_location is required' });
    moves = [{ from_location: from, to_location: defaultTo, qty }];
  } else {
    moves = movesIn;
  }

  const normalized: { from_location: string; to_location: string; qty: number }[] = [];
  for (const moveRaw of moves) {
    const move = (typeof moveRaw === 'object' && moveRaw !== null ? moveRaw : {}) as Record<string, unknown>;
    const from = String(move['from_location'] ?? '').trim().toUpperCase();
    const to = String(move['to_location'] ?? defaultTo).trim().toUpperCase();
    const qty = move['qty'] != null ? phpIntCast(move['qty']) : 0;
    if (from === '') return reply.code(422).send({ message: 'from_location is required' });
    if (to === '') return reply.code(422).send({ message: 'to_location is required for ' + from });
    if (from === to) return reply.code(422).send({ message: from + ' destination must differ from source' });
    if (qty <= 0) return reply.code(422).send({ message: 'qty must be greater than 0' });
    normalized.push({ from_location: from, to_location: to, qty });
  }

  if (normalized.length === 0) return reply.code(422).send({ message: 'select at least one source location' });

  const product = await db.selectFrom('os_products').selectAll().where('sku', '=', sku).executeTakeFirst();
  if (!product) return reply.code(404).send({ message: 'sku not found' });

  try {
    // Kysely 0.29: db.transaction().execute(cb).
    await db.transaction().execute(async (trx) => {
      for (const mv of normalized) {
        const r = await applyOneConsolidationMove(trx, product.id, mv.from_location, mv.to_location, mv.qty);
        if (r !== true) throw r;
      }
    });
  } catch (e) {
    if (e instanceof MoveFailed) return reply.code(e.status).send({ message: e.message });
    // PHP Log::error — the message goes to the log only, not the response.
    console.error('consolidation move failed: ' + (e as Error).message);
    return reply.code(500).send({ message: 'move failed' });
  }

  reply.send({ success: true, sku: product.sku, moves: normalized });
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
  // T25b (web.php:371-376, 461-462).
  route(app, { verb: 'post', path: '/inventory.upload', name: 'inventory.upload', middleware: MIDDLEWARE, handler: uploadTransfer });
  any(app, { path: '/inventory.transferdata', name: 'inventory.transferdata', middleware: MIDDLEWARE, handler: transferData });
  route(app, { verb: 'put', path: '/inventory.createTransfer', name: 'inventory.createTransfer', middleware: MIDDLEWARE, handler: createTransfer });
  route(app, { verb: 'post', path: '/inventory.updateTransfer', name: 'inventory.updateTransfer', middleware: MIDDLEWARE, handler: updateTransfer });
  route(app, { verb: 'delete', path: '/inventory.deleteTransfer', name: 'inventory.deleteTransfer', middleware: MIDDLEWARE, handler: deleteTransfer });
  // No `as` name in web.php for these two.
  route(app, { verb: 'get', path: '/api/inventory/consolidation', middleware: MIDDLEWARE, handler: consolidation });
  route(app, { verb: 'post', path: '/api/inventory/consolidation/move', middleware: MIDDLEWARE, handler: moveConsolidation });
}
