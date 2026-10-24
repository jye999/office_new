// J4: Runner.php actions matching /walmart/ that are scheduled (uncommented) in
// Kernel.php: get-walmart-items (GetWalmartItems), update-walmart-inventory
// (UpdateWalmartInventory) and upload-walmart-tracking
// (UploadWalmartTracking + CheckWalmartAcknowledgeOrders). The commented-out ones
// (walmart, walmart-dsv, get-walmart-dsv-items, update-walmart-dsv-inventory,
// upload-walmart-dsv-tracking) are not invoked by any route/page (grep of the
// action names), so they stay unregistered and fall through to Runner's silent
// unknown-action no-op.
// Every Walmart request and DB write below is skipped under DRY_RUN=1 at the
// action level (the lib additionally gates its POSTs itself).

import { sql } from 'kysely';
import { db, nowDb } from '../../db.js';
import { Walmart } from '../../lib/walmart.js';

const dryRun = () => process.env.DRY_RUN === '1';
const quietDryRun = (action: string) => {
  console.info(`[DRY_RUN] sync ${action}: Walmart request and DB writes skipped`);
  return 0;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PHP !empty($shipResult): [] / {} / '' / '0' / null / undefined all count as empty.
function phpNonEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// ---- GetWalmartItems ----

// PHP's $itemnames list, kept verbatim: 'category' appears twice.
const ITEM_NAMES = [
  'sku', 'name', 'category', 'price', 'currency', 'public_status', 'change_reason', 'lifecycle_status', 'qty', 'ship_methods', 'wpid', 'id', 'gtin', 'upc', 'image', 'shelf', 'category', 'offer_startdate', 'offer_enddate', 'created', 'updated', 'url', 'reviewCount', 'rating', 'searchable',
];

// PHP array_combine(): count mismatch throws (PHP 8 ValueError); a duplicate key keeps its
// first position and takes the later value, so 'category' ends up as the 17th field.
function arrayCombine(names: string[], values: (string | null)[]): Record<string, string | null> {
  if (values.length !== names.length) throw new Error('array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements');
  const out: Record<string, string | null> = {};
  for (let i = 0; i < names.length; i++) out[names[i]] = values[i] ?? null;
  return out;
}

const ESCAPES: Record<string, string> = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '\x1a': '\\Z' };
const esc = (v: string | null): string =>
  v === null ? 'NULL' : `'${v.replace(/[\0\n\r\\'\x1a]/g, (c) => ESCAPES[c])}'`;

// Laravel WalmartItem::insert: the column list is the first row's keys (the 24 distinct names).
// Raw SQL because the values are CSV fields escaped by esc(). Exported for the j4 test (running
// it for real truncates the shared os_walmart_items table).
export function walmartItemsInsertSql(rows: Record<string, string | null>[]): string {
  const cols = Object.keys(rows[0]);
  const tuples = rows.map((r) => `(${cols.map((c) => esc(r[c])).join(', ')})`).join(', ');
  return `insert into os_walmart_items (${cols.join(', ')}) values ${tuples}`;
}

export const WALMART_ITEM_NAMES = ITEM_NAMES;

async function getWalmartItems(): Promise<void> {
  const items = await new Walmart().getItemReport();
  if (items.length > 0) {
    await sql.raw('truncate os_walmart_items').execute(db); // WalmartItem::truncate()
    const rows = items.slice(1).map((item) => arrayCombine(ITEM_NAMES, item.slice(1)));
    if (rows.length > 0) await sql.raw(walmartItemsInsertSql(rows)).execute(db); // PHP insert([]) is a no-op
  }
  // DB::statement: raw SQL, not prefix-translated.
  await sql.raw(`update os_grant_orderdetail
        inner join os_walmart_items wi
        on os_grant_orderdetail.asin = wi.sku
        set os_grant_orderdetail.image = wi.image,
        os_grant_orderdetail.sku = wi.sku
        where os_grant_orderdetail.store='W' and os_grant_orderdetail.image=''`).execute(db);
}

// ---- UpdateWalmartInventory ----

async function updateWalmartInventory(): Promise<void> {
  const currentDatetime = nowDb();
  const items = await db.selectFrom('os_walmart_items').selectAll().execute();
  const itemsToUpdate: { sku: string; qty: number }[] = [];
  for (const i of items) {
    const product = await db
      .selectFrom('os_product_map').selectAll().where('store', '=', 'W').where('externalId', '=', i.sku).executeTakeFirst();
    if (product && product.qty !== null) {
      const prod = await db.selectFrom('os_products').selectAll().where('sku', '=', product.sku).executeTakeFirst();
      if (prod) {
        let inventoryCount = 0;
        for (const l of await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', prod.id).execute()) {
          if ((l.location ?? '').toUpperCase().includes('PO')) continue;
          // PHP loose compares: null countdate < datetime string is true (counted),
          // null qty >= 0 is true (adds 0); a product_map qty of 0 divides to Infinity.
          // SAFETY: countdate is typed Date; mysql2 dateStrings makes it 'YYYY-MM-DD HH:mm:ss'.
          const countdate = l.countdate as unknown as string; // SAFETY: typed Date; dateStrings makes it 'YYYY-MM-DD HH:mm:ss'.
          if (l.countdate === null || countdate < currentDatetime) {
            if ((l.qty ?? 0) >= 0) inventoryCount += l.qty ?? 0;
          }
        }
        itemsToUpdate.push({ sku: i.sku, qty: Math.floor(inventoryCount / product.qty) });
      }
    }
  }
  await new Walmart().updateInventory(itemsToUpdate);
}

// ---- UploadWalmartTracking (+ CheckWalmartAcknowledgeOrders) ----

async function uploadWalmartTracking(): Promise<void> {
  const walmart = new Walmart();
  const orders = await db
    .selectFrom('os_grant_order').selectAll().where('store', '=', 'W').where('status', '=', 'submit').execute();
  for (const o of orders) {
    // foreach ($o->tracking): the last row wins (tracking null -> '').
    let tracking = '';
    let tracking_date = '';
    for (const t of await db.selectFrom('os_trackings').selectAll().where('orderId', '=', o.orderId).execute()) {
      tracking = t.tracking ?? '';
      // SAFETY: created_at is typed Date; mysql2 dateStrings makes it 'YYYY-MM-DD HH:mm:ss'.
      const d = ((t.created_at as unknown as string) ?? ''); // toDateString() . 'T' . toTimeString() . 'Z'
      tracking_date = `${d.slice(0, 10)}T${d.slice(11, 19)}Z`;
    }
    let update = true;
    for (const od of await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', o.orderId).execute()) {
      const shipResult = await walmart.shipOrder(o.orderId, [
        { lineNumber: od.subOrderId ?? '', lineQty: od.qty, tracking, tracking_date },
      ]);
      if (phpNonEmpty(shipResult)) {
        console.error('failed to ship ' + o.orderId);
        update = false;
      }
      await sleep(1000); // PHP sleep(1) per line
    }
    if (update) {
      await db.updateTable('os_grant_order').set({ status: 'Done', updated_at: nowDb() as never }).where('id', '=', o.id).execute();
    }
  }
}

async function checkWalmartAcknowledgeOrders(startDate?: string): Promise<void> {
  const walmart = new Walmart();
  const start = startDate ?? nowDb(new Date(Date.now() - 48 * 60 * 60 * 1000)).slice(0, 10);
  const result = await walmart.getReleasedOrders(start, 'Acknowledged');
  if (!phpNonEmpty(result)) return;
  // The stripped <ns3:list> reply: {meta: {totalCount}, elements: {order}}.
  const reply = result as {
    meta?: { totalCount?: string };
    elements?: { order: { purchaseOrderId: string } | Array<{ purchaseOrderId: string }> };
  };
  console.info('total orders ' + reply.meta?.totalCount);
  if (Number(reply.meta?.totalCount) > 0) {
    // $result->elements->order: one object when totalCount == 1, an array otherwise.
    const node = reply.elements?.order;
    for (const order of node === undefined ? [] : Array.isArray(node) ? node : [node]) {
      const o = await db
        .selectFrom('os_grant_order')
        .selectAll()
        .where('orderId', '=', String(order.purchaseOrderId))
        .where('store', '=', 'W')
        .executeTakeFirst();
      if (o && (await db.selectFrom('os_trackings').select('Id').where('orderId', '=', o.orderId).execute()).length > 0) {
        await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: nowDb() as never }).where('id', '=', o.id).execute();
      }
    }
  }
}

export const walmartActions: Record<string, (arg1?: string) => Promise<number>> = {
  'get-walmart-items': async () => { if (dryRun()) return quietDryRun('get-walmart-items'); await getWalmartItems(); return 0; },
  'update-walmart-inventory': async () => { if (dryRun()) return quietDryRun('update-walmart-inventory'); await updateWalmartInventory(); return 0; },
  'upload-walmart-tracking': async () => {
    if (dryRun()) return quietDryRun('upload-walmart-tracking');
    await uploadWalmartTracking();
    await checkWalmartAcknowledgeOrders();
    return 0;
  },
};
