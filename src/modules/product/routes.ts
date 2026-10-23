// ProductController: Vue SPA shell (Product@vue) + the list/get JSON APIs the
// compiled bundle (public/js/app.js) calls (routes/web.php:380,411-415,438-440;
// routes/api.php:38,61-62).
//
// Quirks kept (plan/NOTES.md):
// - routes/api.php GETs were UNAUTHENTICATED in the old app; the inventory
//   marks them role:admin,user,remote — guarded with session auth (the
//   intentional security change, the Vue bundle sends the session cookie).
// - listProducts()/listProductLocations(): sort/order columns are interpolated
//   raw into ORDER BY (Laravel 5.4 orderBy accepts a raw column string).
// - listProductSkus() returns skus as a json_encode()d STRING.
// - getAjaxBySku() returns the JSON string 'product not found' (404) both when
//   the sku param is missing and when no product matches.
// - The four regex catch-alls (/ListProducts, /InventoryCount,
//   /InventoryConsolidation, /Orders) are T03's not-found fallbacks.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, sql } from '../../db.js';
import { input } from '../../http.js';
import { any, notFoundPage, registerFallback, route } from '../../router.js';
import { json_encode, render } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

// ---------------------------------------------------------------- shared bits

// Laravel 'numeric' = PHP is_numeric (whitespace-tolerant numeric string/number).
function laravelNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && !Number.isNaN(Number(v));
  return false;
}

// Product model: no $hidden/$casts; $appends = ['type', 'sku_num']
// (mb_substr(sku, 0, 1) / mb_substr(sku, 1); null sku -> '' like PHP 7.4).
function productToJson(row: Row, locations: Row[], images: Row[]): Row {
  const chars = [...String(row['sku'] ?? '')];
  return {
    ...row,
    type: chars[0] ?? '',
    sku_num: chars.slice(1).join(''),
    locations,
    images,
  };
}

// SAFETY: selectAll() yields one object per DB row with every column present
// (Eloquent serialises all columns), so the Record<string, unknown> cast is
// exact; values are never read as a narrower type than the generated schema.
async function productWithRelations(id: number): Promise<Row> {
  // SAFETY: selectAll() row -> Record (see header comment).
  const row = (await db.selectFrom('os_products').selectAll().where('id', '=', id).executeTakeFirst()) as unknown as Row;
  if (!row) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  // hasMany: no ORDER BY (insertion order), same as Eloquent's eager loads.
  // SAFETY: full os_product_locations row -> Record.
  const locations = (await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', id)
    .execute()) as unknown as Row[]; // SAFETY: full rows (see above)
  // os_product_images.product_id is a VARCHAR column in this DB (kept as-is).
  const images = (await db
    .selectFrom('os_product_images')
    .selectAll()
    .where('product_id', '=', String(id))
    .execute()) as unknown as Row[]; // SAFETY: full rows (see above)
  return productToJson(row, locations, images);
}

// Eloquent `with('locations','images')`: one IN query per relation, grouped per
// parent in the query's row order (no ORDER BY anywhere).
async function productsWithRelations(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r['id'] as number);
  // SAFETY: full os_product_locations rows -> Record (see productWithRelations).
  const locs = (await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', 'in', ids)
    .execute()) as unknown as Row[];
  // os_product_images.product_id is a VARCHAR column; MySQL coerces the IN list.
  // SAFETY: full os_product_images rows -> Record (see productWithRelations).
  const imgs = (await db
    .selectFrom('os_product_images')
    .selectAll()
    .where('product_id', 'in', ids.map(String))
    .execute()) as unknown as Row[];
  const group = (all: Row[]): Map<number, Row[]> => {
    const m = new Map<number, Row[]>();
    for (const r of all) {
      const k = Number(r['product_id']);
      const a = m.get(k) ?? [];
      a.push(r);
      m.set(k, a);
    }
    return m;
  };
  const lm = group(locs);
  const im = group(imgs); // SAFETY: product_id coerced via Number() (varchar column)

  return rows.map((r) => productToJson(r, lm.get(r['id'] as number) ?? [], im.get(r['id'] as number) ?? []));
}

async function vue(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // $title is set but the view uses none of it.
  await render(req, reply, 'product/vue', { title: 'vue' });
}

// ---------------------------------------------------------------- route actions

// Product@getAjax (web.php:440): findOrFail + with(locations, images).
async function getAjax(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  // SAFETY: {id} projection of the os_products row.
  const row = (await db.selectFrom('os_products').select('id').where('id', '=', id).executeTakeFirst()) as unknown as
    | { id: number }
    | undefined;
  // findOrFail: 404 with the app's Symfony page (T03), not fastify's JSON.
  if (!row) return notFoundPage(reply);
  reply.send(await productWithRelations(row.id));
}

// Product@getAjaxBySku (web.php:438-439).
async function getAjaxBySku(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sku = input(req, 'sku');
  if (sku === null) return reply.type('application/json; charset=utf-8').code(404).send(JSON.stringify('product not found'));
  // SAFETY: full os_products row -> Record (see productWithRelations).
  const row = (await db.selectFrom('os_products').selectAll().where('sku', '=', String(sku)).executeTakeFirst()) as unknown as
    | Row
    | undefined;
  if (!row) return reply.type('application/json; charset=utf-8').code(404).send(JSON.stringify('product not found'));
  reply.send(await productWithRelations(row.id as number)); // SAFETY: os_products.id is a NOT NULL PK
}

// Product@listProducts (api.php:38).
async function listProducts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let q = db.selectFrom('os_products').selectAll().where('status', '=', 'Active');
  const filter = input(req, 'filter');
  if (filter !== null && filter !== '') {
    const f = `%${String(filter)}%`;
    q = q.where((eb) =>
      eb.or([
        eb('name', 'like', f),
        eb('chinese', 'like', f),
        eb('sku', 'like', f),
        eb('vendor_sku', 'like', f),
        eb('upc', '=', String(filter)),
      ]),
    );
  }
  const [{ total }] = (await q.clearSelect().select(sql`count(*)`.as('total')).execute()) as { total: number }[];
  const sort = input(req, 'sort');
  const order = input(req, 'order');
  if (sort !== null && sort !== '') {
    // SAFETY: raw interpolation, exactly like Laravel 5.4 orderBy($sort, $order).
    const dir = order !== null && order !== '' ? String(order) : 'asc';
    q = q.orderBy(sql.raw(`${String(sort)} ${dir}`));
  }
  const page = input(req, 'page');
  if (laravelNumeric(page)) {
    let p = Math.max(1, Number(page));
    let pageSize = 100;
    const ps = input(req, 'pageSize');
    if (laravelNumeric(ps)) pageSize = Number(ps);
    q = q.offset(pageSize * (p - 1)).limit(pageSize);
  }
  // SAFETY: full os_products rows -> Record (see productWithRelations).
  const rows = (await q.execute()) as unknown as Row[];
  reply.send({ total, products: await productsWithRelations(rows) });
}

// Product@listProductLocations (api.php:61).
async function listProductLocations(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let q = db.selectFrom('os_product_locations').selectAll();
  const filter = input(req, 'filter');
  if (filter !== null && filter !== '') {
    // orWhere(location like) + orWhereHas('product', sku like) — the base query
    // has no where, so the or-chains sit at the top level like in PHP.
    const f = `%${String(filter)}%`;
    q = q.where((eb) =>
      eb.or([
        eb('location', 'like', f),
        eb.exists(
          db
            .selectFrom('os_products')
            .select('id')
            // Eloquent has() generates `os_products.id = os_product_locations.product_id`.
            .where(sql<boolean>`os_products.id = os_product_locations.product_id`)
            .where('sku', 'like', f),
        ),
      ]),
    );
  }
  const [{ total }] = (await q.clearSelect().select(sql`count(*)`.as('total')).execute()) as { total: number }[];
  const sort = input(req, 'sort');
  const order = input(req, 'order');
  if (sort !== null && sort !== '') {
    const dir = order !== null && order !== '' ? String(order) : 'asc';
    q = q.orderBy(sql.raw(`${String(sort)} ${dir}`));
  } else {
    q = q.orderBy('location', 'asc');
  }
  const page = input(req, 'page');
  if (laravelNumeric(page)) {
    const p = Math.max(1, Number(page));
    let pageSize = 100;
    const ps = input(req, 'pageSize');
    if (laravelNumeric(ps)) pageSize = Number(ps);
    q = q.offset(pageSize * (p - 1)).limit(pageSize);
  }
  // SAFETY: full os_product_locations rows -> Record (see productWithRelations).
  const rows = (await q.execute()) as unknown as Row[];
  const locations: Row[] = [];
  for (const row of rows) {
    // with(['product' => q.whereNotNull('sku')])
    const product =
      (await db
        .selectFrom('os_products')
        .selectAll()
        .where('id', '=', row.product_id as number) // SAFETY: PK reference
        .where('sku', 'is not', null)
        .executeTakeFirst()) ?? null;
    locations.push({ ...row, product: productToJsonOf(product) });
  }
  reply.send({ total, locations });
}

function productToJsonOf(row: Row | null): Row | null {
  // Eager-load constraint whereNotNull('sku') — the product has no relations here.
  if (!row) return null;
  const chars = [...String(row['sku'] ?? '')];
  return { ...row, type: chars[0] ?? '', sku_num: chars.slice(1).join('') };
}

// Product@listProductSkus (api.php:62): DB::table('products') (os_ prefix).
async function listProductSkus(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const skus = await db.selectFrom('os_products').select('sku').groupBy('sku').orderBy('sku').execute();
  const list = skus.filter((s) => s.sku !== null).map((s) => s.sku as string);
  // $result["skus"] = json_encode($list) — a JSON-encoded STRING (PHP escapes '/').
  reply.send({ skus: json_encode(list) });
}

// ---------------------------------------------------------------- registration

export function registerProductRoutes(app: FastifyInstance): void {
  // web.php:380
  route(app, { verb: 'get', path: '/vue', name: 'vue', roles: ROLES, handler: vue });
  // web.php:411-413,415: regex catch-alls live in T03's not-found fallback.
  registerFallback('ListProducts', vue);
  registerFallback('InventoryCount', vue);
  registerFallback('InventoryConsolidation', vue);
  registerFallback('Orders', vue);
  // web.php:414 — any verbs; the resource's /product/{id} (lowercase, T27) is a
  // different path, so this owns /Product/{id} for all verbs, like the old app.
  any(app, { path: '/Product/{id}', roles: ROLES, handler: vue });
  // web.php:438-440
  route(app, { verb: 'get', path: '/api/product.sku', name: '/api/product.sku', roles: ROLES, handler: getAjaxBySku });
  route(app, { verb: 'get', path: '/product.sku', name: 'product.sku', roles: ROLES, handler: getAjaxBySku });
  route(app, { verb: 'get', path: '/api/product/{id}', roles: ROLES, handler: getAjax });
  // api.php:38,61-62 (session auth: intentional security change, see header).
  route(app, { verb: 'get', path: '/api/products', name: 'products', roles: ROLES, handler: listProducts });
  route(app, { verb: 'get', path: '/api/productLocations', name: 'productLocations', roles: ROLES, handler: listProductLocations });
  route(app, { verb: 'get', path: '/api/productSkus', name: 'productSkus', roles: ROLES, handler: listProductSkus });
}
