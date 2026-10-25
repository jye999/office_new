// OrderController (routes/web.php:298-303, 336-339; api.php:56; role:admin,user,remote).
// No $hidden/$appends on GrantOrder/GrantOrderDetail, so a serialised model is
// every DB column plus the eager-loaded relations. Quirks kept (plan/NOTES.md):
// - pickList groupBy=item 500s: hwc `products` table is absent from the shared DB;
// - DeleteMsg links to /funny/{id}/delete (copy-paste from the scaffold);
// - printing() 500s when all labels exist (no wkhtmltopdf binary in the env,
//   same as the old app's SnappyPDF);
// - show() takes the orderId (not the numeric id) from both {id} routes.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from '../../auth.js';
import { config } from '../../config.js';
import { db, hwcPool, nowDb, sql } from '../../db.js';
import { input, lredirect, redirectBack } from '../../http.js';
import { btDeleting } from '../../lib/ajaxis.js';
import { any, resource, route } from '../../router.js';
import { disk } from '../../storage.js';
import { date, paginateHtml, render, strtotime, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];

type Row = Record<string, unknown>;

// SAFETY: kysely-codegen row interfaces have no index signature; the module
// only reads string/number columns by name and re-keys them for JSON.
const asRow = (r: unknown): Row => r as Row;
const asRows = (r: readonly unknown[]): Row[] => r as Row[];

// Eloquent serialises attributes in table column order (kysely-codegen emits
// the interface alphabetically), so re-key rows before JSON responses.
const ORDER_COLS = [
  'id', 'store', 'orderId', 'purchaseDate', 'paymentDate', 'buyer', 'email', 'phone',
  'recipientName', 'address1', 'address2', 'city', 'state', 'zip', 'country',
  'created_at', 'updated_at', 'status', 'PendingShipment', 'priority', 'notesFromBuyer',
  'selfNotes', 'shippingCost', 'tax', 'discount', 'total', 'planShipDate',
  'trackingStatus', 'feedbackStatus', 'externalId',
];
const DETAIL_COLS = [
  'id', 'store', 'orderId', 'subOrderId', 'itemId', 'asin', 'name', 'qty', 'price',
  'image', 'variation', 'made', 'notes', 'assignedTo', 'promiseDate', 'handling',
  'shipLevel', 'created_at', 'updated_at', 'isPrime', 'sku',
];
function orderRow(o: Row): Row {
  return Object.fromEntries([...ORDER_COLS, 'detail'].map((k) => [k, o[k]]));
}
function detailRow(d: Row): Row {
  return Object.fromEntries(DETAIL_COLS.map((k) => [k, d[k]]));
}

function isAjax(req: FastifyRequest): boolean {
  return req.headers['x-requested-with'] === 'XMLHttpRequest';
}

// Laravel binds positional {param} args by position (the resource names the
// param 'order'); our extra routes name it 'id'.
function paramId(req: FastifyRequest): string {
  const p = req.params as Record<string, unknown>;
  return String(p.order ?? p.id ?? '');
}

// findOrFail($id) -> 404 when missing (T18/T20 pattern).
async function findOrder(id: number): Promise<Row> {
  const row = await db.selectFrom('os_grant_order').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  return asRow(row);
}

// GrantOrder::with('detail')->whereIn('orderId', $ids): no ORDER BY; details
// eager-loaded by orderId only (no store filter).
async function loadOrders(ids: string[]): Promise<Row[]> {
  const orders = asRows(await db.selectFrom('os_grant_order').selectAll().where('orderId', 'in', ids).execute());
  const details = ids.length
    ? asRows(await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', ids).execute())
    : [];
  return groupDetails(orders, details);
}

function groupDetails(orders: Row[], details: Row[]): Row[] {
  const byOrder = new Map<string, Row[]>();
  for (const d of details) {
    const k = String(d.orderId);
    (byOrder.get(k) ?? byOrder.set(k, []).get(k)!).push(d);
  }
  return orders.map((o) => ({ ...o, detail: byOrder.get(String(o.orderId)) ?? [] }));
}

// GrantOrderDetail::ProductMap(): product_map where store = detail.store and
// externalId = detail.sku; when none, externalId = detail.asin. Returns the
// map row, its Product (products.sku = map.sku) and that product's images and
// locations (natural order, like the unsorted hasMany).
async function loadProductMaps(details: Row[]): Promise<{
  mapOf: (d: Row) => Row | undefined;
  productOf: (map: Row) => Row | undefined;
  imagesOf: (productId: number) => Row[];
  locationsOf: (productId: number) => Row[];
}> {
  const exts = new Set<string>();
  for (const d of details) {
    for (const v of [d.sku, d.asin]) if (typeof v === 'string' && v !== '') exts.add(v);
  }
  const maps = exts.size
    ? asRows(await db.selectFrom('os_product_map').selectAll().where('externalId', 'in', [...exts]).execute())
    : [];
  const mapIndex = new Map<string, Row>();
  for (const m of maps) {
    if (m.store == null) continue;
    const key = `${m.store}\u0000${m.externalId}`;
    if (!mapIndex.has(key)) mapIndex.set(key, m); // hasOne -> first row
  }
  const mapOf = (d: Row): Row | undefined => {
    if (typeof d.sku === 'string' && d.sku !== '' && d.store != null) {
      const m = mapIndex.get(`${d.store}\u0000${d.sku}`);
      if (m) return m;
    }
    if (typeof d.asin === 'string' && d.asin !== '' && d.store != null) return mapIndex.get(`${d.store}\u0000${d.asin}`);
    return undefined;
  };
  const skus = [...new Set(maps.map((m) => m.sku).filter((s): s is string => typeof s === 'string'))];
  const products = skus.length ? asRows(await db.selectFrom('os_products').selectAll().where('sku', 'in', skus).execute()) : [];
  const productIndex = new Map<string, Row>();
  for (const p of products) {
    const sku = typeof p.sku === 'string' ? p.sku : null;
    if (sku != null && !productIndex.has(sku)) productIndex.set(sku, p);
  }
  const productOf = (map: Row): Row | undefined => (typeof map.sku === 'string' ? productIndex.get(map.sku) : undefined);
  const ids = [...productIndex.values()].map((p) => Number(p.id));
  const [images, locations] = await Promise.all([
    ids.length
      ? asRows(await db.selectFrom('os_product_images').selectAll().where('product_id', 'in', ids.map(String)).execute())
      : Promise.resolve([] as Row[]),
    ids.length
      ? asRows(await db.selectFrom('os_product_locations').selectAll().where('product_id', 'in', ids).execute())
      : Promise.resolve([] as Row[]),
  ]);
  const imagesIndex = new Map<number, Row[]>();
  for (const i of images) {
    const pid = Number(i.product_id);
    (imagesIndex.get(pid) ?? imagesIndex.set(pid, []).get(pid)!).push(i);
  }
  const locIndex = new Map<number, Row[]>();
  for (const l of locations) {
    const pid = Number(l.product_id);
    (locIndex.get(pid) ?? locIndex.set(pid, []).get(pid)!).push(l);
  }
  return {
    mapOf,
    productOf,
    imagesOf: (id: number) => imagesIndex.get(id) ?? [],
    locationsOf: (id: number) => locIndex.get(id) ?? [],
  };
}

// ---------------------------------------------------------------- resource

// index(): GrantOrder::where('store','=','E')->paginate(25).
async function orderIndex(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const total = Number((await sql<{ total: number }>`select count(*) as total from os_grant_order where store = 'E'`.execute(db)).rows[0].total);
  const page = Math.max(1, Number(input(req, 'page')) || 1);
  const raw = asRows(
    await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'E').offset((page - 1) * 25).limit(25).execute(),
  );
  const details = raw.length
    ? asRows(
        await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', raw.map((o) => String(o.orderId))).execute(),
      )
    : [];
  await render(req, reply, 'order/index', {
    orders: groupDetails(raw, details),
    ordersRender: paginateHtml(total, 25, page, url('order')),
  });
}

async function orderCreate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await render(req, reply, 'order/create');
}

// store(): plain inserts (Eloquent timestamps); the relation save() overwrites
// the $od->orderId='' with the order's orderId; then redirect('order').
async function orderStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const now = nowDb();
  // $order->orderId = $request->orderId (null stays null -> strict-mode insert
  // fails -> 500, same as the old app).
  const rawIns = await db
    .insertInto('os_grant_order')
    // SAFETY: plain column names/values; kysely's InsertObject typing is
    // stricter than the runtime contract (see the Row note above).
    .values({
      orderId: input(req, 'orderId') ?? null,
      store: 'O',
      recipientName: input(req, 'recipientName') ?? '',
      address1: input(req, 'address1') ?? '',
      address2: input(req, 'address2') ?? '',
      city: input(req, 'city') ?? '',
      state: input(req, 'state') ?? '',
      zip: input(req, 'zip') ?? '',
      country: 'US',
      created_at: now,
      updated_at: now,
    } as never)
    .executeTakeFirst();
  const ins = rawIns ? asRow(rawIns) : undefined;
  const storedOrderId = ins?.orderId ?? input(req, 'orderId') ?? '';
  const itemId = arrayField(req, 'itemId');
  const qty = arrayField(req, 'qty');
  // for($i=0;$i<sizeof($request->itemId);$i++): sizeof(null|string) is a warning -> ErrorException -> 500 (after the order insert).
  if (!Array.isArray(itemId)) throw new Error('sizeof(): Parameter must be an array or an object that implements Countable');
  for (let i = 0; i < itemId.length; i++) {
    // `$request->qty[$i]` on a missing/short qty is an undefined offset notice -> 500 (earlier details stay saved).
    if (!Array.isArray(qty) || !(i in qty)) throw new Error(`Undefined offset: ${i}`);
    // name/price are NOT NULL and never set: the old app's non-strict connection stores their column defaults.
    await db
      .insertInto('os_grant_orderdetail')
      .values({ store: 'O', orderId: storedOrderId, itemId: String(itemId[i]), qty: String(qty[i]), created_at: now, updated_at: now } as never)
      .execute();
  }
  lredirect(req, reply, url('order'));
}

async function orderShow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  if (isAjax(req)) {
    reply.type('text/html; charset=UTF-8').send(url(`order/${id}`));
    return;
  }
  const orders = await loadOrders([id]);
  const buyerStats: Record<string, string[]> = {};
  const itemStats: Record<string, number> = {};
  for (const o of orders) {
    for (const i of o.detail as Row[]) {
      const addrKey = `${o.address1 ?? ''}${o.zip ?? ''}`;
      (buyerStats[addrKey] ??= []).push(String(o.orderId));
      (buyerStats[String(o.email ?? '')] ??= []).push(String(o.orderId));
      const asinKey = String(i.asin ?? '');
      itemStats[asinKey] = (itemStats[asinKey] ?? 0) + (Number(i.qty) || 0);
    }
  }

  const auth = await currentUser(req);
  const staffs = auth.user
    ? await db
        .selectFrom('os_staffs')
        .selectAll()
        .where('status', '=', 'Active')
        .where('company_id', '=', auth.user.company_id)
        .orderBy('name')
        .orderBy('name')
        .execute()
    : [];

  // PHP time()/strtotime(): both in the app timezone, so the difference is
  // tz-independent.
  const nowSec = Math.floor(Date.now() / 1000);
  const viewOrders = orders.map((o) => {
    const prioVal = o.priority; // varchar(15); PHP loose ==1 / ==true
    const prioLoose = prioVal != null && prioVal !== '' && prioVal !== '0';
    const multiCount = (buyerStats[String(o.email ?? '')] ?? []).length;
    const addrOrders = buyerStats[`${o.address1 ?? ''}${o.zip ?? ''}`] ?? [];
    const multiHtml =
      addrOrders.length > 1
        ? `<br> Multi-orders ${addrOrders.map((b) => `<br><a href='#${b}'>${b}</a><br>`).join('')}`
        : '';
    return {
      ...o,
      _multiCount: multiCount,
      _multiHtml: multiHtml,
      _prioBtn: prioVal === '1' ? 'UnPrioritize' : 'Prioritize',
      _emailClean: String(o.email ?? '').replace(/@marketplace\.amazon\.com/g, ''),
      _searchBuyer: `${o.address1 ?? ''} ${o.address2 ?? ''}, ${o.state ?? ''} ${o.zip ?? ''}`,
      detail: (o.detail as Row[]).map((i) => {
        const prime = i.isPrime === 'true';
        const due = Math.ceil((nowSec - strtotime(String(i.promiseDate ?? ''))) / 86400) >= -1;
        return {
          ...i,
          _rowMade: i.made === 'Y' ? 'made' : '',
          _rowHalf: i.made === 'H' ? 'halfmade' : '',
          _rowPriority: prime || prioLoose || due ? 'priority' : '',
          _prime: prime,
          _shipDate: date('Y-m-d', strtotime(`${i.promiseDate ?? ''} - 2 days`)),
        };
      }),
    };
  });
  await render(req, reply, 'order/show', {
    orders: viewOrders,
    buyerStats,
    itemStats,
    staffs,
    quickSearchContent: '',
  });
}

async function orderEdit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number(paramId(req));
  if (isAjax(req)) {
    reply.type('text/html; charset=UTF-8').send(url(`order/${id}/edit`));
    return;
  }
  const order = await findOrder(id);
  await render(req, reply, 'order/edit', { title: 'Edit - order', order });
}

// update(): findOrFail + save() of an unmodified model (Eloquent save() with
// no dirty attributes is a no-op) + redirect('order').
async function orderUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number(paramId(req));
  await findOrder(id);
  lredirect(req, reply, url('order'));
}

// destroy(): findOrFail + delete, then echoes URL::to('order') as a body.
async function orderDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number(paramId(req));
  await findOrder(id);
  await db.deleteFrom('os_grant_order').where('id', '=', id).execute();
  reply.type('text/html; charset=UTF-8').send(url('order'));
}

// DeleteMsg(): Ajaxis modal (note the /funny/ link — copied from the scaffold).
async function orderDeleteMsg(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = paramId(req);
  const msg = btDeleting('Warning!!', 'Would you like to remove This?', `/funny/${id}/delete`);
  if (isAjax(req)) reply.type('text/html; charset=UTF-8').send(msg);
}

// ---------------------------------------------------------------- extras

// Laravel array form field: `orders[]` (form-body keeps the key as-is; a
// single value arrives as a string and is wrapped like PHP's `[]` key).
type FormField = string | string[] | null;
function arrayField(req: FastifyRequest, key: string): FormField {
  const direct = input<string | string[]>(req, key);
  if (direct != null) return direct;
  const bracked = input<string>(req, `${key}[]`);
  return bracked == null ? null : [bracked];
}

// POST /getMultiOrders: whereIn('orderId', $request->orders) — non-array input
// is a PHP fatal (whereIn expects an array).
async function getMultiOrders(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ids = arrayField(req, 'orders');
  if (!Array.isArray(ids)) throw new Error('whereIn() expects an array');
  const orders = await loadOrders(ids.map(String));
  reply.send(orders.map((o) => orderRow(o)));
}

// GET /packing?id=a,b: orders by purchaseDate asc.
async function packing(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ids = String(input(req, 'id') ?? '').split(',');
  const orders = asRows(
    await db
      .selectFrom('os_grant_order')
      .selectAll()
      .where('orderId', 'in', ids)
      .orderBy('purchaseDate', 'asc')
      .execute(),
  );
  const details = orders.length
    ? asRows(
        await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', orders.map((o) => String(o.orderId))).execute(),
      )
    : [];
  await render(req, reply, 'order/packing', { orders: groupDetails(orders, details) });
}

// SnappyPDF::loadHTML($html)->setOption('page-width'/'page-height'): shells out
// to wkhtmltopdf (absent in the shared env, so the old app 500s too).
function snappyPdf(html: string): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'snappy-'));
  try {
    const inFile = path.join(dir, 'in.html');
    const outFile = path.join(dir, 'out.pdf');
    writeFileSync(inFile, html);
    execFileSync('wkhtmltopdf', ['--page-width', '3.812in', '--page-height', '5.718in', inFile, outFile]);
    return readFileSync(outFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// GET /printing (safe); POST with orders= checks the labels disk and, when all
// labels exist, downloads the multi-label PDF (500s without wkhtmltopdf).
async function printing(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ordersIn = input<unknown>(req, 'orders');
  if (ordersIn != null) {
    if (!Array.isArray(ordersIn)) throw new Error('foreach() argument must be of type array');
    const orders = ordersIn;
    let toPrint = true;
    // The PHP for-loop re-checks the whole list on each i; the outcome equals
    // one pass (kept faithful: same number of exists() calls).
    for (let i = 0; i < orders.length; i++) {
      for (const o of orders) {
        const img = `${o}.png`;
        if (!(await disk('labels').exists(`labels/${img}`))) toPrint = false;
      }
      if (toPrint) {
        const baseUrl = 'https://office.angelisabella.com/storage/labels/labels/';
        const html =
          `<html><body>` +
          orders.map((o) => `<img src='${baseUrl}${o}.png'  style='width: 3.812in;height: 5.718in;' />`).join('') +
          `</body></html>`;
        const buf = snappyPdf(html);
        reply.type('application/pdf').header('Content-Disposition', 'attachment; filename=orders.pdf').send(buf);
        return;
      }
      // Log::info(' mass print not ready') + usleep(500): not user-observable.
    }
  }
  await render(req, reply, 'order/print', { orders: [] });
}

// GET /api/orders (name: orders): all null-status orders + detail, image
// fallback via the ProductMap chain (config('app.use_local_image') first).
async function listOrders(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orders = asRows(await db.selectFrom('os_grant_order').selectAll().where('status', 'is', null).execute());
  const details = orders.length
    ? asRows(
        await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', orders.map((o) => String(o.orderId))).execute(),
      )
    : [];
  const maps = await loadProductMaps(details);
  const useLocalImage = !!config.USE_LOCAL_IMAGE; // env('USE_LOCAL_IMAGE', false)
  // Reading $i->ProductMap loads the relation, so it serialises as `product_map`
  // (null, or the map + product [type/sku_num appends] + images) after the columns.
  const byOrder = new Map<string, Row[]>();
  for (const d of details) {
    const row = detailRow(d);
    if (useLocalImage) row.image = `/images/${d.asin}.jpg`;
    if (row.image == null || row.image === '') {
      const map = maps.mapOf(d);
      const product = map ? maps.productOf(map) : undefined;
      const images = product ? maps.imagesOf(Number(product.id)) : [];
      if (images.length > 0) row.image = images[0].filename;
      const chars = [...String(product?.sku ?? '')];
      row.product_map = map
        ? { ...map, product: product ? { ...product, type: chars[0] ?? '', sku_num: chars.slice(1).join(''), images } : null }
        : null;
    }
    const k = String(d.orderId);
    (byOrder.get(k) ?? byOrder.set(k, []).get(k)!).push(row);
  }
  reply.send({
    total: orders.length,
    orders: orders.map((o) => ({ ...orderRow(o), detail: byOrder.get(String(o.orderId)) ?? [] })),
  });
}

// GET /pickList: WINDY -> company 2, mermaid -> 8, else redirect back with an
// 'error' flash (the layouts never read it, so it is not replayed).
async function pickList(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = input(req, 'id');
  const store = input(req, 'store');
  let companyId: number;
  if (store === 'WINDY') companyId = 2;
  else if (store === 'mermaid') companyId = 8;
  else {
    redirectBack(req, reply);
    return;
  }
  const ids = String(id ?? '').split(',');
  const groupBy = input(req, 'groupBy') ?? 'item';

  if (groupBy === 'order') {
    const orders = await loadOrders(ids);
    const maps = await loadProductMaps(orders.flatMap((o) => o.detail as Row[]));
    // Collection::sortBy: $results[sum][] = $item (stable append), then ksort.
    const bySum: Record<number, Row[]> = {};
    for (const o of orders) {
      const sum = (o.detail as Row[]).reduce((s: number, d) => s + (Number(d.qty) || 0), 0);
      (bySum[sum] ??= []).push(o);
    }
    const sorted = Object.keys(bySum)
      .sort((a, b) => (Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0))
      .flatMap((k) => bySum[Number(k)]);
    const viewOrders = sorted.map((o) => ({
      ...o,
      detail: (o.detail as Row[]).map((i) => {
        const map = maps.mapOf(i) ?? null;
        const product = map ? maps.productOf(map) : undefined;
        let locations = '';
        if (product) {
          for (const l of maps.locationsOf(Number(product.id))) locations += `${l.location ?? ''}-${l.qty ?? ''}<br/>`;
        }
        return { ...i, _pm: map, _locations: locations };
      }),
    }));
    await render(req, reply, 'order/pickList', { orders: viewOrders, groupBy });
    return;
  }

  if (groupBy === 'item') {
    const orders = await loadOrders(ids);
    const allDetails = orders.flatMap((o) => o.detail as Row[]);
    const maps = await loadProductMaps(allDetails);
    const items: Record<string, { asin: unknown; qty: number; name: unknown; sku: string; location: string }> = {};
    const hwc: Record<string, Row[]> = {};
    for (const o of orders) {
      for (const i of o.detail as Row[]) {
        let asin = i.asin;
        if (asin == null || asin === '') asin = i.itemId;
        if (asin != null && asin !== '') {
          // HwcProduct::where('company_id',...)->where(sku|upc|fnsku): the hwc
          // `products` table is absent from the shared DB -> query throws -> 500
          // (same as the old app; raw SQL — the table is outside the generated
          // Kysely hwc types, like the old app's own connection).
          // SAFETY: hwcPool.query returns [rows, fields]; only rows are used.
          const res = (await hwcPool.query(
            'select * from products where company_id = ? and (sku = ? or upc = ? or fnsku = ?)',
            [companyId, asin, asin, asin],
          )) as unknown as [Row[]];
          hwc[String(asin)] = res[0];
        }
        const key = String(asin ?? '');
        if (key in items) {
          items[key].qty += Number(i.qty) || 0;
        } else {
          let sku = '';
          let location = '';
          const map = maps.mapOf(i);
          if (map) {
            sku = String(map.sku ?? '');
            const product = maps.productOf(map);
            if (product) {
              for (const l of maps.locationsOf(Number(product.id))) location += `${l.location ?? ''} - ${l.qty ?? ''}<br/>`;
            }
          }
          items[key] = { asin: i.asin, qty: Number(i.qty) || 0, name: i.name, sku, location };
        }
      }
    }
    // usort by location (strcmp byte order; stable).
    const sorted = Object.values(items).sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
    // print_r($h->fnsku): the string as-is, 'NULL' for null.
    const viewItems = sorted.map((it) => ({
      ...it,
      _hwcHtml:
        it.asin == null
          ? ''
          : (hwc[String(it.asin)] ?? []).map((h) => (h.fnsku == null ? 'NULL' : String(h.fnsku))).join(''),
    }));
    await render(req, reply, 'order/pickList', { items: viewItems, groupBy, hwc });
    return;
  }

  // groupBy=='customer' (and anything else): the PHP returns null -> empty 200.
  reply.type('text/html; charset=UTF-8').send('');
}

export function registerOrderRoutes(app: FastifyInstance): void {
  resource(app, '/order', {
    index: orderIndex,
    create: orderCreate,
    store: orderStore,
    show: orderShow,
    edit: orderEdit,
    update: orderUpdate,
    destroy: orderDestroy,
  }, { roles: ROLES });
  route(app, { verb: 'get', path: '/order/{id}/show', roles: ROLES, handler: orderShow });
  route(app, { verb: 'post', path: '/order/{id}/update', roles: ROLES, handler: orderUpdate });
  route(app, { verb: 'get', path: '/order/{id}/delete', roles: ROLES, handler: orderDestroy });
  route(app, { verb: 'get', path: '/order/{id}/deleteMsg', roles: ROLES, handler: orderDeleteMsg });
  route(app, { verb: 'post', path: '/getMultiOrders', name: 'getMultiOrders', roles: ROLES, handler: getMultiOrders });
  any(app, { path: '/packing', name: 'packing', roles: ROLES, handler: packing });
  any(app, { path: '/pickList', name: 'pickList', roles: ROLES, handler: pickList });
  any(app, { path: '/printing', name: 'printing', roles: ROLES, handler: printing });
  // api.php:56 (middleware 'api' = throttle+bindings+cors; the inventory's
  // security_change adds the role guard — was unauthenticated in the old app).
  route(app, { verb: 'get', path: '/api/orders', name: 'orders', roles: ROLES, handler: listOrders });
}
