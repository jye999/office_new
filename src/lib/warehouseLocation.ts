// Port of app/Helpers/WarehouseLocation.php — only the members the PDA API
// (T24) calls: sortStocked/level (via ensureDefaultStillStocked) and
// mergeDuplicateLocations. Later tasks (T25a consolidation) add parse/
// isAdjacent/cluster/recommend/pickForQty from the same PHP file.

import { db } from '../db.js';
import { nowDb } from '../db.js';
import { strtotime } from '../view.js';

// SAFETY: Kysely types the datetime/timestamp columns as Date, but the pool
// runs with mysql2 dateStrings (T00), so runtime values are 'YYYY-MM-DD
// HH:mm:ss' strings — same shape PHP PDO gave Laravel.
const dateCol = (v: string | null) => v as unknown as Date | null;

// Kysely row shape for os_product_locations (the parts this helper touches).
interface LocRow {
  id: number;
  product_id: number;
  location: string | null;
  qty: number | null;
  packing: number | null;
  carton: number | null;
  countdate: string | null;
}

// Kysely rows come back with the real DB types (int -> number), so the null
// check is the only narrowing needed.

// PHP strcasecmp: byte-wise compare, case-insensitive (ASCII location codes).
function strcasecmp(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    const d = la.charCodeAt(i) - lb.charCodeAt(i);
    if (d !== 0) return d;
  }
  return la.length - lb.length;
}

// Floor from the last L number (O1B1L1 → 1). Unparseable → 9999.
function level(code: string): number {
  const m = /L(\d+)$/.exec(code.toUpperCase().trim());
  return m ? parseInt(m[1], 10) : 9999;
}

// Stocked bins (qty > 0), lowest floor first, then location code.
function sortStocked(rows: LocRow[]): { location: string; quantity: number; location_id?: number }[] {
  const filtered: { location: string; quantity: number; location_id?: number }[] = [];
  for (const row of rows) {
    const qty = row.qty === null ? 0 : row.qty;
    const code = row.location ? row.location.trim() : '';
    if (qty <= 0 || code === '') continue;
    const entry: { location: string; quantity: number; location_id?: number } = { location: code, quantity: qty };
    entry.location_id = row.id; // PHP includes location_id when isset — always set on DB rows
    filtered.push(entry);
  }
  filtered.sort((a, b) => {
    const la = level(a.location);
    const lb = level(b.location);
    if (la !== lb) return la < lb ? -1 : 1;
    return strcasecmp(a.location, b.location);
  });
  return filtered;
}

// If stored default is gone or has qty 0, move it to the next stocked
// lowest-L bin (or null if none remain).
export async function ensureDefaultStillStocked(productId: number): Promise<string | null> {
  const product = await db
    .selectFrom('os_products')
    .select(['id', 'default_location'])
    .where('id', '=', productId)
    .executeTakeFirst();
  if (!product) return null;

  const defaultNorm = (product.default_location ?? '').trim().toUpperCase();
  if (defaultNorm === '') return null;

  const rows = await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', productId)
    .where('qty', '>', 0)
    .execute();
  // SAFETY: selectAll() rows are a superset of LocRow with identical field types.
  const sorted = sortStocked(rows as unknown as LocRow[]);

  for (const row of sorted) {
    if (row.location.toUpperCase() === defaultNorm) return product.default_location;
  }

  const next = sorted.length > 0 ? sorted[0].location : null;
  // SAFETY: os_products.updated_at is typed NOT NULL Date; runtime is a string (dateStrings).
  await db
    .updateTable('os_products')
    .set({ default_location: next, updated_at: nowDb() as unknown as Date })
    .where('id', '=', productId)
    .execute();
  return next;
}

// PHP is_numeric: true for '12', '12.5', '1e3', ''→false.
function isNumeric(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));
}

// Collapse rows that share product_id + the same location name
// (case/space insensitive). Qty is summed onto the lowest id; extras are
// deleted. Packing stays the shared value when rows agree, otherwise the
// latest-countdate row. Carton is qty / packing when packing > 0.
// Pick allocations are pointed at the surviving row.
export async function mergeDuplicateLocations(productId: number | null = null): Promise<number> {
  let query = db.selectFrom('os_product_locations').selectAll().orderBy('id', 'asc');
  if (productId !== null) query = query.where('product_id', '=', productId);
  // SAFETY: selectAll() rows are a superset of LocRow with identical field types.
  const rows = (await query.execute()) as unknown as LocRow[];

  const groups = new Map<string, LocRow[]>();
  for (const row of rows) {
    const loc = (row.location ?? '').trim().toUpperCase();
    if (loc === '') continue;
    const key = `${row.product_id}|${loc}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group[0];
    let sumQty = 0;
    let latestCount = keeper.countdate;
    let latestPacking = keeper.packing;
    let latestCarton = keeper.carton;
    const packings: number[] = [];
    const dropIds: number[] = [];
    for (const row of group) {
      sumQty += row.qty === null ? 0 : row.qty;
      if (row.countdate && (latestCount === null || strtotime(row.countdate) > strtotime(latestCount))) {
        latestCount = row.countdate;
        latestPacking = row.packing;
        latestCarton = row.carton;
      }
      if (row.packing !== null && isNumeric(row.packing)) {
        packings.push(Number(row.packing));
      }
      if (row.id !== keeper.id) dropIds.push(row.id);
    }

    let packing = latestPacking;
    if (packings.length > 0) {
      const unique = [...new Set(packings)];
      if (unique.length === 1) packing = unique[0];
    }
    let carton = latestCarton;
    if (isNumeric(packing) && Number(packing) > 0) {
      carton = sumQty / Number(packing);
      if (Math.floor(carton) === carton) carton = Math.trunc(carton);
    }

    await db
      .updateTable('os_product_locations')
      .set({
        qty: sumQty,
        packing,
        carton,
        location: (keeper.location ?? '').trim().toUpperCase(),
        countdate: dateCol(latestCount),
        updated_at: dateCol(nowDb()),
      })
      .where('id', '=', keeper.id)
      .execute();

    if (dropIds.length > 0) {
      const allocs = await db
        .selectFrom('os_order_pick_allocations')
        .selectAll()
        .where('location_id', 'in', dropIds)
        .execute();
      for (const alloc of allocs) {
        const existing = await db
          .selectFrom('os_order_pick_allocations')
          .selectAll()
          .where('source', '=', alloc.source)
          .where('order_id', '=', alloc.order_id)
          .where('sku', '=', alloc.sku)
          .where('location_id', '=', keeper.id)
          .executeTakeFirst();
        if (existing) {
          await db
            .updateTable('os_order_pick_allocations')
            .set({
              pull_qty: existing.pull_qty + alloc.pull_qty,
              location: (keeper.location ?? '').trim().toUpperCase(),
              updated_at: dateCol(nowDb()),
            })
            .where('id', '=', existing.id)
            .execute();
          await db.deleteFrom('os_order_pick_allocations').where('id', '=', alloc.id).execute();
        } else {
          await db
            .updateTable('os_order_pick_allocations')
            .set({
              location_id: keeper.id,
              location: (keeper.location ?? '').trim().toUpperCase(),
              updated_at: dateCol(nowDb()),
            })
            .where('id', '=', alloc.id)
            .execute();
        }
      }
    }

    await db.deleteFrom('os_product_locations').where('id', 'in', dropIds).execute();
    removed += dropIds.length;
  }
  return removed;
}
