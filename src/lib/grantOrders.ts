// WindyController & FourController shared logic. Both controllers are
// byte-identical except $store ('WINDY'/'FOUR'), the redirect target names and
// Four's extra importEbay (CSV extension). Quirks kept (see plan/NOTES.md):
// store() 500s when the file has no data rows ($items never assigned -> PHP
// foreach warning -> Laravel 500); loadUnshipped dedupes detail rows by the
// ORDER array ($co), not the detail array; Eloquent Model::insert() bypasses
// timestamps, so inserted rows get DB defaults; the batch flush happens when
// insertCount > 10 AFTER the push (12-row batches) and the counter carries
// over between the two arrays.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb, sql } from '../db.js';
import { input, lredirect } from '../http.js';
import { date, render, strtotime } from '../view.js';

type Item = Record<string, string>;

// preg_split('/\R/') + explode("\t") + array_combine: first line is the header,
// a data row is kept only when it has the same field count. Returns undefined
// when no data row matched ($items never assigned in the PHP).
export function parseItems(content: string): Item[] | undefined {
  const lines = content.split(/\r\n|\r|\n/);
  let fields: string[] = [];
  const items: Item[] = [];
  for (const line of lines) {
    if (fields.length === 0) {
      fields = line.split('\t');
    } else {
      const item = line.split('\t');
      if (fields.length === item.length) {
        const rec: Item = {};
        for (let i = 0; i < fields.length; i++) rec[fields[i]] = item[i];
        items.push(rec);
      }
    }
  }
  return items.length ? items : undefined;
}

// PHP in_array($needle, $haystack) on these flat string arrays: same keys in
// the same order, loose value == (all values are strings here).
function arrLooseEq(a: Item, b: Item): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false;
  return true;
}

export async function loadUnshipped(store: string, items: Item[]): Promise<void> {
  const ao: Item[] = [];
  const aod: Item[] = [];
  const orderIds = items.map((i) => i['order-id']);
  const now = nowDb();

  const orders = await db
    .selectFrom('os_grant_order')
    .selectAll()
    .where('store', '=', store)
    .where(sql<boolean>`(status <> 'Done' or status is null)`)
    .execute();
  for (const od of orders) {
    if (!orderIds.includes(od.orderId)) {
      await db
        .updateTable('os_grant_order')
        .set({ status: 'Done', selfNotes: 'mark done from runner', updated_at: now as never })
        .where('id', '=', od.id)
        .execute();
    }
  }

  for (const i of items) {
    const ot = await db
      .selectFrom('os_grant_order')
      .select(['id', 'orderId'])
      .where('store', '=', store)
      .where(sql<boolean>`(PendingShipment <> '1' or PendingShipment is null)`)
      .where('orderId', '=', i['order-id'])
      .executeTakeFirst();
    // sizeof($ot->tracking) > 0 — the Tracking hasMany on orderId.
    if (ot) {
      const trackings = await db.selectFrom('os_trackings').select('Id').where('orderId', '=', ot.orderId).execute();
      if (trackings.length > 0) {
        await db
          .updateTable('os_grant_order')
          .set({ status: 'submit', updated_at: now as never })
          .where('id', '=', ot.id)
          .execute();
      }
    }
  }

  for (const i of items) {
    // $o = GrantOrder::where('orderId', ...) — NOTE: no store filter in the PHP.
    const o = await db.selectFrom('os_grant_order').select('id').where('orderId', '=', i['order-id']).executeTakeFirst();
    if (!o) {
      const co: Item = {
        orderid: i['order-id'],
        store,
        purchaseDate: date('Y-m-d H:i:s', strtotime(i['purchase-date'])),
        paymentDate: date('Y-m-d H:i:s', strtotime(i['payments-date'])),
        buyer: i['buyer-name'],
        email: i['buyer-email'],
        phone: i['buyer-phone-number'],
        recipientName: i['recipient-name'],
        address1: i['ship-address-1'],
        address2: `${i['ship-address-2'] ?? ''} ${i['ship-address-3'] ?? ''}`,
        city: i['ship-city'],
        state: i['ship-state'],
        zip: i['ship-postal-code'],
        country: i['ship-country'],
      };
      if (!ao.some((x) => arrLooseEq(x, co))) ao.push(co);

      const od = await db
        .selectFrom('os_grant_orderdetail')
        .selectAll()
        .where('orderId', '=', i['order-id'])
        .where('itemId', '=', i['order-item-id'])
        .executeTakeFirst();
      if (!od) {
        const cod: Item = {
          orderid: i['order-id'],
          store,
          itemId: i['order-item-id'],
          name: i['product-name'],
          qty: i['quantity-purchased'],
          image: i['pic'] ?? '',
          asin: i['ASIN'] ?? '',
          promiseDate: date('Y-m-d H:i:s', strtotime(i['promise-date'])),
          shipLevel: i['ship-service-level'],
          isPrime: i['is-prime'],
          sku: i['sku'],
        };
        // shortcut: strtotime("… +1 day") wall-clock day add ~= +86400s; differs
        // by one hour on DST transition days (not exercised by the app's data).
        if (i['is-prime'] === 'true') cod.promiseDate = date('Y-m-d H:i:s', strtotime(i['purchase-date']) + 86400);
        if (!aod.some((x) => arrLooseEq(x, co))) aod.push(cod); // PHP dedupes by $co, not $cod (quirk)
      } else if (od.asin === '' || od.image === '') {
        // Eloquent save() is a no-op when nothing is dirty — only write when a
        // field was actually set (isset in the PHP).
        const set: Record<string, unknown> = {};
        if (i['ASIN'] !== undefined) set['asin'] = i['ASIN'];
        if (i['pic'] !== undefined) set['image'] = i['pic'];
        if (Object.keys(set).length) {
          set['updated_at'] = now;
          await db.updateTable('os_grant_orderdetail').set(set as never).where('id', '=', od.id).execute();
        }
      }
    }
  }

  // Model::insert(): plain multi-row INSERT of exactly these columns (no
  // timestamps). Batch flush when insertCount > 10 AFTER the push; the counter
  // keeps its value between the two arrays (PHP uses one $insertCount).
  let insertCount = 0;
  let temp: Item[] = [];
  for (const row of ao) {
    temp.push(row);
    if (insertCount > 10) {
      await db.insertInto('os_grant_order').values(temp as never).execute();
      insertCount = 0;
      temp = [];
    } else {
      insertCount++;
    }
  }
  if (insertCount > 0) {
    await db.insertInto('os_grant_order').values(temp as never).execute();
    insertCount = 0;
    temp = [];
  }
  for (const row of aod) {
    temp.push(row);
    if (insertCount > 10) {
      await db.insertInto('os_grant_orderdetail').values(temp as never).execute();
      insertCount = 0;
      temp = [];
    } else {
      insertCount++;
    }
  }
  if (insertCount > 0) {
    await db.insertInto('os_grant_orderdetail').values(temp as never).execute();
    insertCount = 0;
    temp = [];
  }

  const ordersA = await db
    .selectFrom('os_grant_order')
    .select(['id', 'orderId', 'status'])
    .where('store', '=', 'A')
    .where('status', 'is', null)
    .execute();
  for (const od of ordersA) {
    if (!orderIds.includes(od.orderId) && od.status !== 'Shipped' && od.status !== 'submit') {
      // status is null here, so both != checks are always true in the PHP.
      await db
        .updateTable('os_grant_order')
        .set({ status: 'Done', selfNotes: 'mark done from runner2', updated_at: now as never })
        .where('id', '=', od.id)
        .execute();
    }
  }
}

// index(): ?status=processed -> status not null and not '' (take 1000), else
// status is null. detail + tracking eager-loaded like the view's lazy loads
// (hasMany on orderId only, no ORDER BY).
export async function grantOrdersIndex(
  req: FastifyRequest,
  reply: FastifyReply,
  store: string,
  view: string,
): Promise<void> {
  const status = input(req, 'status');
  const processed = status !== null && status === 'processed';
  const orders = await db
    .selectFrom('os_grant_order')
    .selectAll()
    .where('store', '=', store)
    .where('status', processed ? 'is not' : 'is', null)
    .$if(processed, (q) => q.where('status', '<>', '').limit(1000))
    .orderBy('created_at', 'desc')
    .execute();
  const ids = orders.map((o) => o.orderId);
  const [details, trackings] = await Promise.all([
    ids.length
      ? db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', ids).execute()
      : Promise.resolve([]),
    ids.length ? db.selectFrom('os_trackings').selectAll().where('orderId', 'in', ids).execute() : Promise.resolve([]),
  ]);
  const detailBy = new Map<string, unknown[]>();
  for (const d of details) (detailBy.get(d.orderId) ?? detailBy.set(d.orderId, []).get(d.orderId)!).push(d);
  const trackingBy = new Map<string, unknown[]>();
  for (const t of trackings) (trackingBy.get(t.orderId) ?? trackingBy.set(t.orderId, []).get(t.orderId)!).push(t);
  const viewOrders = orders.map((o) => ({
    ...(o as Record<string, unknown>),
    detail: detailBy.get(o.orderId) ?? [],
    tracking: trackingBy.get(o.orderId) ?? [],
  }));
  // date(date("Y-m-d")) — the inner date() output contains no format
  // characters, so PHP returns the same Y-m-d string (verified vs php-cli).
  const today = nowDb().slice(0, 10);
  await render(req, reply, view, { orders: viewOrders, status, ship_startdate: today, ship_enddate: today });
}

// export(): raw SQL (no os_ prefixing applies — the string is copied
// unchanged, params bound), streamed as fputcsv output (tab-separated, every
// cell quoted, CRLF line endings).
export async function grantOrdersExport(req: FastifyRequest, reply: FastifyReply, store: string): Promise<void> {
  const start = input(req, 'ship_startdate');
  const end = input(req, 'ship_enddate');
  const rows = (await sql<{ orderid: string; orderitemid: string; quantity: number; shipdate: string; carriercode: string; carriername: string; trackingnumber: string; shipmethod: string }>`select ot.orderId as orderid,
        ogod.itemId as orderitemid,
        ogod.qty as quantity,
        DATE_FORMAT(ot.created_at,'%Y-%m-%d') as shipdate,
        case when length(ot.tracking)>20 then 'USPS' else 'Fedex' END as carriercode,
        '' as carriername,
        ot.tracking as trackingnumber,
        'Standard' as shipmethod
        from os_trackings ot
        inner join os_grant_orderdetail ogod
        on ot.orderId = ogod.orderId
        where ogod.store=${store} and
        date(ot.created_at) between ${start ?? ''} and ${end ?? ''}`.execute(db)).rows;
  // fputcsv with enclosure '"': every cell quoted, " and \ escaped.
  const cell = (v: unknown) => '"' + String(v ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const header = ['order-id', 'order-item-id', 'quantity', 'ship-date', 'carrier-code', 'carrier-name', 'tracking-number', 'ship-method'].map(cell).join('\t');
  const lines = rows.map((o) =>
    [o.orderid, o.orderitemid, o.quantity, o.shipdate, o.carriercode, o.carriername, o.trackingnumber, o.shipmethod]
      .map(cell)
      .join('\t'),
  );
  reply.raw.writeHead(200, {
    'Content-type': 'text/csv',
    'Content-Disposition': 'attachment; filename=orders.txt',
    Pragma: 'no-cache',
    'Cache-Control': 'must-revalidate, post-check=0, pre-check=0',
    Expires: '0',
  });
  reply.raw.end([header, ...lines].join('\r\n') + '\r\n');
}

// destroy(): deletes grant_orderdetail then grant_order for store + orderId
// (the {id} param is the orderId), then echoes the absolute index URL as HTML.
export async function grantOrdersDestroy(
  req: FastifyRequest,
  reply: FastifyReply,
  store: string,
  indexUrl: string,
): Promise<void> {
  const id = String((req.params as { id: string }).id);
  await db.deleteFrom('os_grant_orderdetail').where('store', '=', store).where('orderId', '=', id).execute();
  await db.deleteFrom('os_grant_order').where('store', '=', store).where('orderId', '=', id).execute();
  reply.type('text/html; charset=UTF-8').send(indexUrl);
}

// store()/importEbay(): multipart upload of ordersfile; only the given
// extension is parsed; the parse result is undefined when there are no data
// rows, which 500s like the PHP's foreach-on-null warning. Always redirects.
export async function grantOrdersUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  store: string,
  extension: 'TXT' | 'CSV',
  redirectName: string,
): Promise<void> {
  let filename = '';
  let buffer: Buffer | null = null;
  if (req.isMultipart()) {
    for await (const part of req.files()) {
      if (part.fieldname !== 'ordersfile') continue;
      filename = part.filename;
      buffer = await part.toBuffer();
    }
  }
  if (filename) {
    // pathinfo($getClientOriginalName())['extension']
    const ext = filename.split('.').pop()?.toUpperCase() ?? '';
    if (ext === extension && buffer) {
      const items = parseItems(buffer.toString('utf8'));
      if (items) await loadUnshipped(store, items);
      else throw new Error('Warning: foreach() argument must be of type array|object, null given');
    }
  }
  lredirect(req, reply, redirectName);
}
