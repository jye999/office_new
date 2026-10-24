// UnshippedController fairePickList / updateFaireWarehouseStatus / updateFairePickerPacker /
// updateProductDefaultLocation / saveOrderPickAllocation (routes/web.php:123-127, role:admin,user,remote).
// NOTE: the GET is not read-only in the old app: it merges duplicate bin rows and seeds
// os_order_pick_allocations for every listed order. Ported as is.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { currentUser } from '../../auth.js';
import { route } from '../../router.js';
import { render } from '../../view.js';
import { applySavedPulls, mergeAllDuplicateLocations, suggestedPulls, type Bin, type Picked } from '../../lib/warehouseLocation.js';
import { date } from '../../view.js';
import { phpUsort } from '../../lib/phpSort.js';
import { generateQuickSearch, isoTs, type Row } from './service.js';

const ROLES = ['admin', 'user', 'remote'];

const PICK_LIST_SQL = String.raw`SELECT DISTINCT
    o.order_id,
    o.display_id,
    o.order_status,
    JSON_UNQUOTE(JSON_EXTRACT(o.content, '$.created_at')) AS created_at,
    o.warehouse_status,
    o.picker,
    o.packer,
    o_name.address_name,
    JSON_UNQUOTE(JSON_EXTRACT(o.content, '$.expected_ship_date')) AS expected_ship_date,

    -- ✅ add sort keys so ORDER BY is compatible with DISTINCT
    STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(o.content, '$.expected_ship_date')), '%Y-%m-%d') AS sort_expected_ship_date,
    STR_TO_DATE(
      REPLACE(JSON_UNQUOTE(JSON_EXTRACT(o.content, '$.created_at')), 'Z', ''),
      '%Y-%m-%dT%H:%i:%s'
    ) AS sort_created_at,

    jt.product_id,
    jt.sku,
    jt.quantity,
    jt.product_name,
    jt.variant_name,
    jt.variant_id,
    MAX(variant.image_url) AS image_url,
    MAX(variant.main_image_url) AS main_image_url,
    p.id AS office_product_id,
    p.default_location,
    GROUP_CONCAT(pl.id ORDER BY pl.location SEPARATOR ', ') AS location_ids,
    GROUP_CONCAT(pl.location ORDER BY pl.location SEPARATOR ', ') AS locations,
    GROUP_CONCAT(pl.qty ORDER BY pl.location SEPARATOR ', ') AS quantities
FROM os_faire_orders o
LEFT JOIN JSON_TABLE(
    o.content,
    '$.items[*]'
    COLUMNS (
        product_id VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.product_id',
        sku VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.sku',
        variant_id VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.variant_id',
        quantity INT PATH '$.quantity',
        product_name VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.product_name',
        variant_name VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.variant_name'
    )
) AS jt ON TRUE
LEFT JOIN JSON_TABLE(
    o.content,
    '$.address'
    COLUMNS (
        address_name VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.company_name'
    )
) AS o_name ON TRUE
LEFT JOIN (
    SELECT
        p.id,
        v.variant_id,
        v.sku,
        v.variant_name,
        MAX(v.image_url) AS image_url,
        JSON_UNQUOTE(JSON_EXTRACT(p.images, '$[0].url')) AS main_image_url
    FROM os_faire_products p,
         JSON_TABLE(
            p.variants,
            '$[*]'
            COLUMNS (
                variant_id VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.id',
                sku VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.sku',
                variant_name VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.name',
                image_url VARCHAR(500) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci PATH '$.images[0].url'
            )
         ) AS v
    GROUP BY v.variant_id, v.sku, v.variant_name, p.id
) variant
ON jt.product_id = variant.id AND jt.sku = variant.sku COLLATE utf8mb3_unicode_ci
LEFT JOIN os_products p ON jt.sku = p.sku COLLATE utf8mb3_unicode_ci
LEFT JOIN os_product_locations pl ON p.id = pl.product_id AND pl.qty > 0
WHERE o.order_status in('PROCESSING','NEW','BACKORDERED')
GROUP BY
    o.order_id,
    o.display_id,
    JSON_UNQUOTE(JSON_EXTRACT(o.content, '$.created_at')),   -- ✅ match selected created_at
    o.warehouse_status,
    o.picker,
    o.packer,
    o_name.address_name,
    JSON_UNQUOTE(JSON_EXTRACT(o.content, '$.expected_ship_date')), -- ✅ match selected expected_ship_date
    jt.product_id,
    jt.sku,
    jt.quantity,
    jt.product_name,
    jt.variant_name,
    jt.variant_id,
    p.id,
    p.default_location
ORDER BY
    sort_expected_ship_date ASC,
    sort_created_at ASC,
    jt.sku ASC;
`;

// (string) cast + trim(), PHP-style null -> ''.
const str = (v: unknown): string => String(v ?? '').replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
const upper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());
// PHP (int) cast of a request value.
function phpInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v) || 0;
  const m = /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(String(v ?? ''));
  return m ? Math.trunc(Number(m[0])) || 0 : 0;
}

type PickItem = Row & { location_quantities: Array<{ location_id: number; location: string; quantity: number }>; visible_locations?: Bin[]; extra_locations?: Bin[] };

async function loadPickAllocations(source: string, orderIds: string[]): Promise<Record<string, Record<string, Record<number, number>>>> {
  const out: Record<string, Record<string, Record<number, number>>> = {};
  if (!orderIds.length) return out;
  const rows = await db.selectFrom('os_order_pick_allocations').selectAll().where('source', '=', source).where('order_id', 'in', orderIds).execute();
  for (const row of rows) {
    const bySku = (out[row.order_id] ??= {});
    (bySku[row.sku] ??= {})[Number(row.location_id)] = Number(row.pull_qty);
  }
  return out;
}

async function loadProcessedFaireOrderIds(orderIds: string[]): Promise<Set<string>> {
  if (!orderIds.length) return new Set();
  const rows = await db.selectFrom('os_faire_processed_orders').select('faire_order_id').distinct().where('faire_order_id', 'in', orderIds).execute();
  return new Set(rows.map((r) => r.faire_order_id));
}

async function faireOrderAlreadyProcessed(orderId: string): Promise<boolean> {
  if (orderId === '') return false;
  const r = await db.selectFrom('os_faire_processed_orders').select('id').where('faire_order_id', '=', orderId).limit(1).executeTakeFirst();
  return r != null;
}

function groupPickListItems(items: PickItem[], savedBySku: Record<string, Record<number, number>>): PickItem[] {
  const grouped = new Map<string, PickItem>();
  for (const item of items) {
    const key = `${item.sku ?? ''}|${item.variant_id ?? ''}|${item.product_id ?? ''}`;
    const g = grouped.get(key);
    if (!g) grouped.set(key, { ...item, location_quantities: [...(item.location_quantities ?? [])] });
    else g.location_quantities = g.location_quantities.concat(item.location_quantities ?? []);
  }
  for (const gi of grouped.values()) {
    const byLocation = new Map<string, { location_id: number; location: string; quantity: number }>();
    for (const lq of gi.location_quantities) {
      const loc = str(lq.location);
      if (loc === '') continue;
      const cur = byLocation.get(loc);
      if (!cur) byLocation.set(loc, { location_id: lq.location_id != null ? phpInt(lq.location_id) : 0, location: loc, quantity: phpInt(lq.quantity) });
      else cur.quantity += phpInt(lq.quantity);
    }
    gi.location_quantities = [...byLocation.values()];
    let picked = suggestedPulls(gi.location_quantities, gi.quantity != null ? phpInt(gi.quantity) : 0, gi.default_location ?? '');
    const sku = gi.sku != null ? String(gi.sku) : '';
    const saved = sku !== '' && savedBySku[sku] != null ? savedBySku[sku] : null;
    picked = applySavedPulls(picked, saved);
    gi.visible_locations = picked.visible;
    gi.extra_locations = picked.extra;
  }
  return [...grouped.values()];
}

async function seedPickAllocations(source: string, orderId: string, items: Array<{ sku?: unknown; visible_locations?: Bin[]; extra_locations?: Bin[] }>, alreadyHasRows: boolean): Promise<void> {
  if (orderId === '') return;
  const existingSkus = new Set<string>();
  if (alreadyHasRows) {
    const skuRows = await db.selectFrom('os_order_pick_allocations').select('sku').distinct().where('source', '=', source).where('order_id', '=', orderId).execute();
    for (const r of skuRows) existingSkus.add(r.sku);
  }
  const now = nowDb();
  for (const item of items) {
    const sku = item.sku != null ? String(item.sku) : '';
    if (sku === '' || existingSkus.has(sku)) continue;
    for (const bin of [...(item.visible_locations ?? []), ...(item.extra_locations ?? [])]) {
      const pull = bin.pull_qty != null ? phpInt(bin.pull_qty) : 0;
      const locationId = bin.location_id != null ? phpInt(bin.location_id) : 0;
      if (pull <= 0 || locationId <= 0) continue;
      await updateOrInsertAllocation({ source, order_id: orderId, sku, location_id: locationId }, { location: bin.location ?? null, pull_qty: pull, updated_at: now });
    }
  }
}

// DB::table('order_pick_allocations')->updateOrInsert($keys, $values)
async function updateOrInsertAllocation(keys: { source: string; order_id: string; sku: string; location_id: number }, values: { location: string | null; pull_qty: number; updated_at: string }): Promise<void> {
  const existing = await db
    .selectFrom('os_order_pick_allocations')
    .select('id')
    .where('source', '=', keys.source)
    .where('order_id', '=', keys.order_id)
    .where('sku', '=', keys.sku)
    .where('location_id', '=', keys.location_id)
    .executeTakeFirst();
  if (!existing) {
    // SAFETY: updated_at is a datetime string written verbatim (nowDb); codegen types it as Date.
    await db.insertInto('os_order_pick_allocations').values({ ...keys, ...values } as never).execute();
  } else {
    await db
      .updateTable('os_order_pick_allocations')
      .set(values as never)
      .where('source', '=', keys.source)
      .where('order_id', '=', keys.order_id)
      .where('sku', '=', keys.sku)
      .where('location_id', '=', keys.location_id)
      .limit(1)
      .execute();
  }
}

async function ensureFaireOrderAllocations(order: { order_id: string; content: unknown }): Promise<void> {
  const orderId = order.order_id ?? '';
  if (orderId === '') return;
  let content = order.content as Row | string | null;
  if (typeof content === 'string') content = JSON.parse(content) as Row;
  const rawItems = (content != null && typeof content === 'object' ? (content as Row)['items'] : null) as Row[] | null;
  const qtyBySku = new Map<string, number>();
  for (const it of rawItems ?? []) {
    const sku = it['sku'] != null ? str(it['sku']) : '';
    if (sku === '') continue;
    qtyBySku.set(sku, (qtyBySku.get(sku) ?? 0) + (it['quantity'] != null ? phpInt(it['quantity']) : 0));
  }
  const items: Array<{ sku: string; quantity: number } & Picked & { visible_locations: Bin[]; extra_locations: Bin[] }> = [];
  for (const [sku, qty] of qtyBySku) {
    const product = await db.selectFrom('os_products').select(['id', 'default_location']).where('sku', '=', sku).executeTakeFirst();
    let locs: Array<Record<string, unknown>> = [];
    let def: unknown = '';
    if (product) {
      def = product.default_location;
      const bins = await db.selectFrom('os_product_locations').select(['id', 'location', 'qty']).where('product_id', '=', product.id as never).where('qty', '>', 0 as never).execute();
      locs = bins.map((b) => ({ location_id: Number(b.id), location: b.location, quantity: Number(b.qty) }));
    }
    const picked = suggestedPulls(locs, qty, def);
    items.push({ sku, quantity: qty, ...picked, visible_locations: picked.visible, extra_locations: picked.extra });
  }
  const has = (await db.selectFrom('os_order_pick_allocations').select('id').where('source', '=', 'faire').where('order_id', '=', orderId).limit(1).executeTakeFirst()) != null;
  await seedPickAllocations('faire', orderId, items, has);
}

export async function prepareFairePickList(): Promise<{ orders: Row[]; quickSearchContent: string }> {
  await mergeAllDuplicateLocations();
  // SET SESSION must run on the same connection as the query.
  const result = await db.connection().execute(async (conn) => {
    await sql`SET SESSION group_concat_max_len = 1000000`.execute(conn);
    return sql<Row>`${sql.raw(PICK_LIST_SQL)}`.execute(conn);
  });
  const byId = new Map<string, Row & { items: PickItem[] }>();
  for (const row of result.rows) {
    const oid = String(row['order_id']);
    if (!byId.has(oid)) {
      byId.set(oid, {
        order_id: row['order_id'],
        display_id: row['display_id'],
        order_status: row['order_status'],
        created_at: row['created_at'],
        warehouse_status: row['warehouse_status'],
        picker: row['picker'],
        packer: row['packer'],
        address_name: row['address_name'],
        expected_ship_date: row['expected_ship_date'],
        items: [],
      });
    }
    const split = (v: unknown): string[] => (v !== null && v !== undefined && v !== '' ? String(v).split(',') : []);
    const locations = split(row['locations']);
    const quantities = split(row['quantities']);
    const locationIds = split(row['location_ids']);
    const locationQuantities: PickItem['location_quantities'] = [];
    for (let i = 0; i < locations.length; i++) {
      if (locations[i] !== undefined && quantities[i] !== undefined) {
        const loc = str(locations[i]);
        const qty = phpInt(str(quantities[i]));
        if (loc === '' || qty <= 0) continue;
        locationQuantities.push({ location_id: locationIds[i] !== undefined ? phpInt(str(locationIds[i])) : 0, location: loc, quantity: qty });
      }
    }
    byId.get(oid)!.items.push({
      product_id: row['product_id'],
      sku: row['sku'],
      quantity: row['quantity'],
      product_name: row['product_name'],
      variant_name: row['variant_name'],
      variant_id: row['variant_id'],
      image_url: row['image_url'],
      main_image_url: row['main_image_url'],
      office_product_id: row['office_product_id'] ?? null,
      default_location: row['default_location'] ?? '',
      location_quantities: locationQuantities,
    });
  }
  const orderIds = [...byId.keys()];
  const allocations = await loadPickAllocations('faire', orderIds);
  const processed = await loadProcessedFaireOrderIds(orderIds);
  for (const [oid, order] of byId) {
    const saved = allocations[oid] ?? {};
    order.items = groupPickListItems(order.items, saved);
    order['processed'] = processed.has(oid);
    await seedPickAllocations('faire', oid, order.items, allocations[oid] !== undefined);
  }
  const orders = [...byId.values()];
  for (const order of orders) {
    // usort by first visible location (PHP 7.4 zend_sort: unstable for ties, replicated).
    const key = (it: PickItem): string => (it.visible_locations && it.visible_locations.length ? str(it.visible_locations[0].location) : 'zzz');
    phpUsort(order.items, (a, b) => {
      const x = key(a);
      const y = key(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  for (const order of orders) decorateForView(order as Row & { items: PickItem[] });
  return { orders, quickSearchContent: await generateQuickSearch() };
}

// The <?php ?> blocks of fairePickList.blade.php, computed here instead of in the template.
function decorateForView(order: Row & { items: PickItem[] }): void {
  const colors: Record<string, string> = { picking: '#b0b0b0', 'ready-to-pack': '#fff5c3', 'ready-to-ship': '#90EE90' };
  order['bgColor'] = colors[String(order['warehouse_status'])] ?? '';
  order['qtySubtotal'] = order.items.reduce((n, it) => n + (it.quantity != null ? phpInt(it.quantity) : 0), 0);
  order['orderDate'] = date('Y-m-d', isoTs(order['created_at']));
  order['shipDate'] = date('Y-m-d', isoTs(order['expected_ship_date']));
  // strtotime(null|bad) is false and PHP compares `false > <non-zero int>` as booleans -> hidden.
  const shipTs = isoTs(order['expected_ship_date']);
  order['showShip'] = shipTs !== 0 && shipTs > -8520336000;
  order['detailsDisplay'] = order['bgColor'] !== '' || order['order_status'] === 'NEW' ? 'none' : 'block';
  for (const item of order.items) {
    const visible = item.visible_locations ?? [];
    const extra = item.extra_locations ?? [];
    const defaultLoc = item.default_location != null ? upper(str(item.default_location)) : '';
    let pullSum = 0;
    let extraHasPull = false;
    for (const vl of visible) pullSum += vl.pull_qty != null ? phpInt(vl.pull_qty) : 0;
    for (const el of extra) {
      const ep = el.pull_qty != null ? phpInt(el.pull_qty) : 0;
      pullSum += ep;
      if (ep > 0) extraHasPull = true;
    }
    const locCount = visible.length + extra.length;
    const shape = (bins: Bin[]) =>
      bins.map((b) => ({
        location: b.location,
        quantity: b.quantity,
        pullQty: b.pull_qty != null ? phpInt(b.pull_qty) : 0,
        locId: b.location_id != null ? phpInt(b.location_id) : 0,
        isDefault: defaultLoc !== '' && upper(b.location) === defaultLoc,
      }));
    item['view'] = {
      itemSku: item.sku != null ? String(item.sku) : '',
      neededQty: item.quantity != null ? phpInt(item.quantity) : 0,
      visible: shape(visible),
      extra: shape(extra),
      pullSum,
      locCount,
      hidePullInput: locCount === 1,
      hidePullMismatch: locCount === 0,
      locsOpen: locCount > 1 && extraHasPull,
      image: item.image_url != null ? item.image_url : item.main_image_url != null ? item.main_image_url : '',
    };
  }
}

export function registerFaireRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/fairePickList',
    name: 'fairePickList',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => render(req, reply, 'fairePickList', await prepareFairePickList()),
  });

  route(app, {
    verb: 'post',
    path: '/updateFaireWarehouseStatus',
    name: 'updateFaireWarehouseStatus',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const displayId = input(req, 'display_id');
      const status = input(req, 'warehouse_status');
      const orders = await db.selectFrom('os_faire_orders').selectAll().where('display_id', '=', String(displayId ?? '')).execute();
      for (const order of orders) {
        // Eloquent builder update() also stamps updated_at.
        await db
          .updateTable('os_faire_orders')
          .set({ warehouse_status: status == null ? null : String(status), updated_at: nowDb() } as never)
          .where('display_id', '=', order.display_id)
          .execute();
        await ensureFaireOrderAllocations(order);
      }
      return reply.send({ success: true });
    },
  });

  route(app, {
    verb: 'post',
    path: '/updateFairePickerPacker',
    name: 'updateFairePickerPacker',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const field = input(req, 'field');
      if (field !== 'picker' && field !== 'packer') return reply.send({ success: false, message: 'Invalid field' });
      const value = input(req, 'value');
      // DB::table()->update(): no updated_at stamp.
      await db
        .updateTable('os_faire_orders')
        .set({ [field]: value == null ? null : String(value) } as never)
        .where('display_id', '=', String(input(req, 'display_id') ?? ''))
        .execute();
      return reply.send({ success: true });
    },
  });

  route(app, {
    verb: 'post',
    path: '/updateProductDefaultLocation',
    name: 'updateProductDefaultLocation',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const skuIn = str(input(req, 'sku'));
      const location = upper(str(input(req, 'location')));
      if (skuIn === '') return reply.code(422).send({ success: false, message: 'sku is required' });
      if (location === '') return reply.code(422).send({ success: false, message: 'location is required' });
      const product = await db.selectFrom('os_products').select(['id', 'sku', 'default_location']).where('sku', '=', skuIn).executeTakeFirst();
      if (!product) return reply.code(404).send({ success: false, message: 'sku not found' });
      const bin = await db
        .selectFrom('os_product_locations')
        .select('location')
        .where('product_id', '=', product.id as never)
        .where(sql<boolean>`UPPER(TRIM(location)) = ${location}`)
        .limit(1)
        .executeTakeFirst();
      if (!bin) return reply.code(404).send({ success: false, message: 'location not found' });
      // Eloquent save() only writes (and stamps updated_at) when the attribute changed.
      if (product.default_location !== bin.location) {
        await db.updateTable('os_products').set({ default_location: bin.location, updated_at: nowDb() } as never).where('id', '=', product.id).execute();
      }
      return reply.send({ success: true, sku: product.sku, default_location: bin.location });
    },
  });

  route(app, {
    verb: 'post',
    path: '/saveOrderPickAllocation',
    name: 'saveOrderPickAllocation',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      let source = str(input(req, 'source') ?? 'faire');
      const orderId = str(input(req, 'order_id'));
      const sku = str(input(req, 'sku'));
      const locationId = phpInt(input(req, 'location_id'));
      const location = upper(str(input(req, 'location')));
      const pullQty = phpInt(input(req, 'pull_qty'));
      if (source === '') source = 'faire';
      if (orderId === '' || sku === '' || locationId <= 0) {
        return reply.code(422).send({ success: false, message: 'order_id, sku, and location_id are required' });
      }
      if (pullQty < 0) return reply.code(422).send({ success: false, message: 'pull_qty must be 0 or more' });
      if (await faireOrderAlreadyProcessed(orderId)) {
        return reply.code(409).send({ success: false, message: 'This order inventory has already been deducted' });
      }
      await updateOrInsertAllocation(
        { source, order_id: orderId, sku, location_id: locationId },
        { location: location !== '' ? location : null, pull_qty: pullQty, updated_at: nowDb() },
      );
      return reply.send({ success: true });
    },
  });
}
