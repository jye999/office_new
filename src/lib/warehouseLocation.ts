// Port of app/Helpers/WarehouseLocation.php — the members the PDA API (T24)
// and the consolidation routes (T25b) call: sortStocked/level (via
// ensureDefaultStillStocked), merge(Duplicate|AllDuplicate)Locations, and
// parse/isAdjacent/cluster/recommend.
// All functions take an optional Kysely instance (default `db`) so callers
// can run them inside a transaction.

import { db, sql } from '../db.js';
import { nowDb } from '../db.js';
import { strtotime } from '../view.js';
import { phpUsort } from './phpSort.js';

type Db = typeof db;

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
export async function ensureDefaultStillStocked(productId: number, k: Db = db): Promise<string | null> {
  const product = await k
    .selectFrom('os_products')
    .select(['id', 'default_location'])
    .where('id', '=', productId)
    .executeTakeFirst();
  if (!product) return null;

  const defaultNorm = (product.default_location ?? '').trim().toUpperCase();
  if (defaultNorm === '') return null;

  const rows = await k
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
  await k
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
export async function mergeDuplicateLocations(productId: number | null = null, k: Db = db): Promise<number> {
  let query = k.selectFrom('os_product_locations').selectAll().orderBy('id', 'asc');
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
      const allocs = await k
        .selectFrom('os_order_pick_allocations')
        .selectAll()
        .where('location_id', 'in', dropIds)
        .execute();
      for (const alloc of allocs) {
        const existing = await k
          .selectFrom('os_order_pick_allocations')
          .selectAll()
          .where('source', '=', alloc.source)
          .where('order_id', '=', alloc.order_id)
          .where('sku', '=', alloc.sku)
          .where('location_id', '=', keeper.id)
          .executeTakeFirst();
        if (existing) {
          await k
            .updateTable('os_order_pick_allocations')
            .set({
              pull_qty: existing.pull_qty + alloc.pull_qty,
              location: (keeper.location ?? '').trim().toUpperCase(),
              updated_at: dateCol(nowDb()),
            })
            .where('id', '=', existing.id)
            .execute();
          await k.deleteFrom('os_order_pick_allocations').where('id', '=', alloc.id).execute();
        } else {
          await k
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

    await k.deleteFrom('os_product_locations').where('id', 'in', dropIds).execute();
    removed += dropIds.length;
  }
  return removed;
}

// Merge same-name location rows for every product that currently has them.
// PHP raw SQL: GROUP BY product_id, UPPER(TRIM(location)) HAVING COUNT(*) > 1.
export async function mergeAllDuplicateLocations(k: Db = db): Promise<number> {
  // SAFETY: sql.raw in groupBy is the only way to mirror the PHP's
  // expression group-by; Kysely types it loosely.
  const rows = await k
    .selectFrom('os_product_locations')
    .where(sql<boolean>`${sql.ref('location')} is not null`)
    .where(sql<boolean>`TRIM(${sql.ref('location')}) <> ${''}`)
    .select('product_id')
    // SAFETY: Kysely 0.29 has no havingRaw; sql.raw casts to never.
    .groupBy(sql.raw('product_id, UPPER(TRIM(location))') as never)
    .having(sql.raw('COUNT(*) > 1') as never)
    .execute();
  const seen = new Set<number>();
  let removed = 0;
  for (const row of rows) {
    const pid = Number(row.product_id);
    if (seen.has(pid)) continue;
    seen.add(pid);
    removed += await mergeDuplicateLocations(pid, k);
  }
  return removed;
}

// ---------------------------------------------------------------- consolidation

interface ParsedCode {
  code: string;
  prefix: string;
  aisle: number;
  bay: number;
  level: number;
}

// PHP static parse: ^([A-Z]+)(\d+)B(\d+)L(\d+)$ on the upper-trimmed code.
export function parse(code: unknown): ParsedCode | null {
  const c = String(code ?? '').trim().toUpperCase();
  if (c === '') return null;
  const m = /^([A-Z]+)(\d+)B(\d+)L(\d+)$/.exec(c);
  if (!m) return null;
  return { code: c, prefix: m[1], aisle: parseInt(m[2], 10), bay: parseInt(m[3], 10), level: parseInt(m[4], 10) };
}

// 4-neighbor adjacency on aisle/bay/level; same coordinates count as together.
export function isAdjacent(a: ParsedCode | string | null, b: ParsedCode | string | null): boolean {
  const pa = typeof a === 'string' ? parse(a) : a;
  const pb = typeof b === 'string' ? parse(b) : b;
  if (!pa || !pb) return false;
  if (pa.prefix !== pb.prefix || pa.aisle !== pb.aisle) return false;
  const bayDiff = Math.abs(pa.bay - pb.bay);
  const levelDiff = Math.abs(pa.level - pb.level);
  if (bayDiff === 0 && levelDiff === 0) return true;
  if (bayDiff === 1 && levelDiff === 0) return true;
  if (bayDiff === 0 && levelDiff === 1) return true;
  return false;
}

// PHP (int) cast on row qty: null/garbage -> 0.
function rowInt(v: unknown): number {
  const s = String(v ?? '').trim();
  const m = /^[-+]?\d+/.exec(s);
  return m ? parseInt(m[0], 10) : 0;
}

export interface ClusterRow {
  id: number;
  location: string | null;
  qty: number | null;
  packing: number | null;
  carton: number | null;
}

// BFS clusters over same-code / adjacent bins.
export function cluster(locations: ClusterRow[]): ClusterRow[][] {
  const n = locations.length;
  if (n === 0) return [];
  const parsed: (ParsedCode | null)[] = [];
  const codes: string[] = [];
  const visited: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const raw = locations[i].location ?? '';
    codes[i] = String(raw).trim().toUpperCase();
    parsed[i] = parse(codes[i]);
    visited[i] = false;
  }
  const clusters: ClusterRow[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const queue = [i];
    visited[i] = true;
    const group: ClusterRow[] = [];
    while (queue.length > 0) {
      const idx = queue.shift() as number;
      group.push(locations[idx]);
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        const sameCode = codes[idx] !== '' && codes[idx] === codes[j];
        const closeBy = isAdjacent(parsed[idx], parsed[j]);
        if (sameCode || closeBy) {
          visited[j] = true;
          queue.push(j);
        }
      }
    }
    clusters.push(group);
  }
  return clusters;
}

export interface Recommendation {
  clusters: { locations: ClusterRow[]; codes: string[]; total_qty: number; max_location: ClusterRow | null }[];
  suggested_target: string;
  suggested_moves: { from: string; to: string; qty: number; reason: string }[];
}

// Consolidation recommendation, or null when already one adjacent cluster.
export function recommend(locations: ClusterRow[]): Recommendation | null {
  const clusters = cluster(locations);
  if (clusters.length < 2) return null;
  const summaries = clusters.map((cl) => {
    let totalQty = 0;
    let maxQty = -1;
    let maxLoc: ClusterRow | null = null;
    const codes: string[] = [];
    for (const row of cl) {
      const qty = rowInt(row.qty);
      totalQty += qty;
      codes.push(row.location ?? '');
      if (qty > maxQty) {
        maxQty = qty;
        maxLoc = row;
      }
    }
    return { locations: cl, codes, total_qty: totalQty, max_location: maxLoc };
  });
  // PHP usort: total_qty desc (JS sort is stable; PHP 7 usort is not — ties keep row order).
  summaries.sort((a, b) => (a.total_qty === b.total_qty ? 0 : a.total_qty > b.total_qty ? -1 : 1));
  const targetRow = summaries[0].max_location;
  const targetCode = targetRow && targetRow.location ? targetRow.location : '';
  const suggestedMoves: Recommendation['suggested_moves'] = [];
  for (let i = 1; i < summaries.length; i++) {
    for (const row of summaries[i].locations) {
      const from = row.location ?? '';
      suggestedMoves.push({ from, to: targetCode, qty: rowInt(row.qty), reason: 'scattered from ' + from });
    }
  }
  return { clusters: summaries, suggested_target: targetCode, suggested_moves: suggestedMoves };
}

// ---- pick-list helpers (U4: fairePickList / ensureFaireOrderAllocations) --------------------
// Same PHP functions as sortStocked/level above, but over plain bin arrays
// ({location, qty|quantity, location_id?}) instead of os_product_locations rows.

export type Bin = { location: string; quantity: number; location_id?: number; pull_qty?: number };
export type Picked = { visible: Bin[]; extra: Bin[] };

const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const phpTrim = (v: unknown): string => String(v ?? '').replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

function sortStockedBins(locations: Array<Record<string, unknown>>): Bin[] {
  const filtered: Bin[] = [];
  for (const row of locations) {
    let qty = 0;
    if (row['qty'] != null) qty = parseInt(String(row['qty']), 10) || 0;
    else if (row['quantity'] != null) qty = parseInt(String(row['quantity']), 10) || 0;
    const code = row['location'] != null ? phpTrim(row['location']) : '';
    if (qty <= 0 || code === '') continue;
    const entry: Bin = { location: code, quantity: qty };
    if (row['location_id'] != null) entry.location_id = parseInt(String(row['location_id']), 10) || 0;
    filtered.push(entry);
  }
  phpUsort(filtered, (a, b) => {
    const la = level(a.location);
    const lb = level(b.location);
    if (la !== lb) return la < lb ? -1 : 1;
    return strcasecmp(a.location, b.location);
  });
  return filtered;
}

// Default bin first (if still stocked), then lowest L, until qty covers the order.
export function pickForQty(locations: Array<Record<string, unknown>>, neededQty: number, defaultLocation: unknown): Picked {
  const sorted = sortStockedBins(locations);
  const need = Math.trunc(Number(neededQty)) || 0;
  const defaultNorm = asciiUpper(phpTrim(defaultLocation));
  let defaultIndex: number | null = null;
  if (defaultNorm !== '') {
    for (let i = 0; i < sorted.length; i++) {
      if (asciiUpper(sorted[i].location) === defaultNorm) {
        defaultIndex = i;
        break;
      }
    }
  }
  const ordered = defaultIndex !== null ? [sorted[defaultIndex], ...sorted.filter((_, i) => i !== defaultIndex)] : sorted;
  const visible: Bin[] = [];
  const extra: Bin[] = [];
  let sum = 0;
  for (const row of ordered) {
    if (visible.length === 0 || sum < need) {
      visible.push(row);
      sum += row.quantity;
    } else extra.push(row);
  }
  return { visible, extra };
}

// Same bins as pickForQty, with pull_qty filled until neededQty (extras 0).
export function suggestedPulls(locations: Array<Record<string, unknown>>, neededQty: number, defaultLocation: unknown): Picked {
  const picked = pickForQty(locations, neededQty, defaultLocation);
  let remaining = Math.trunc(Number(neededQty)) || 0;
  for (const row of picked.visible) {
    const pull = remaining > 0 ? Math.min(remaining, row.quantity) : 0;
    row.pull_qty = pull;
    remaining -= pull;
  }
  for (const row of picked.extra) row.pull_qty = 0;
  return picked;
}

// Overlay saved pull_qty by location_id. Missing ids become 0.
export function applySavedPulls(picked: Picked, saved: Record<number, number> | null): Picked {
  if (saved == null) return picked;
  for (const key of ['visible', 'extra'] as const) {
    for (const row of picked[key]) row.pull_qty = saved[row.location_id ?? 0] != null ? saved[row.location_id ?? 0] : 0;
  }
  return picked;
}
