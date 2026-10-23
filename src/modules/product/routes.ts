// ProductController: Vue SPA shell (Product@vue) + the list/get JSON APIs the
// compiled bundle (public/js/app.js) calls (routes/web.php:380,411-415,438-440;
// routes/api.php:38,61-62) + the store/update/images/locations write APIs
// (routes/web.php:442-450,460; routes/api.php:40-42).
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
// - store(): name/sku are assigned UNCONDITIONALLY (update with a missing name
//   sets name to null); in_stock uses PHP 7 loose equality ('0' == false is
//   FALSE in PHP 7, unlike PHP 8); the out-of-stock branch mass-updates all
//   location rows to qty 0 (with updated_at, as Eloquent's Builder::update does).
// - updateImage/deleteImage: deleteImage removes ONLY the product_image_full
//   file (the icon copy is orphaned); uploadMultipleImage writes both disks.
// - updateLocations(): the create branch uses the body's product_id, NOT the
//   route id (kept quirk).
// - updateLocationByLocId(): uppercases location only in the update branch,
//   not the insert branch; a missing/empty/null id goes to the insert branch
//   (PHP 7: `$input['id'] != null` is false for every string).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { allInput, input, redirectBack } from '../../http.js';
import { image } from '../../images.js';
import { mergeDuplicateLocations, ensureDefaultStillStocked } from '../../lib/warehouseLocation.js';
import { disk } from '../../storage.js';
import { any, notFoundPage, registerFallback, registerRoute, route } from '../../router.js';
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

// response()->json('ok') / json('<str>'): Laravel JSON-encodes the string, but
// Fastify sends plain strings as text/plain — set the type and encode explicitly.
function jsonStr(reply: FastifyReply, s: string, code = 200): void {
  reply.code(code).type('application/json; charset=utf-8').send(JSON.stringify(s));
}

// ---------------------------------------------------------------- T27 shared

// store()'s `has()` scalar fields, in statement order (ProductController.php
// 131-287); wholesale_category_list and in_stock are handled separately.
const STORE_FIELDS = [
  'chinese', 'description', 'status', 'upc', 'length', 'width', 'height', 'weight',
  'weight_unit', 'asin', 'ebay', 'shopify', 'etsy', 'houzz', 'walmart', 'main_image',
  'bullet_point_1', 'bullet_point_2', 'bullet_point_3', 'bullet_point_4', 'bullet_point_5',
  'cost', 'price', 'wholesale_price', 'wholesale_cat_id', 'wholesale_category_list',
  'base_sku', 'units_per_sale', 'vendor_sku',
  'package_length', 'package_width', 'package_height', 'package_weightLb', 'package_weightOz',
  'units_per_pack', 'qty_per_inner_box', 'qty_per_ctn', 'ctn_length', 'ctn_width',
  'ctn_height', 'ctn_cbm', 'product_cbm', 'ctn_weightLb', 'ctn_weightOz',
  'in_production', 'in_production_qty', 'in_freight', 'in_freight_qty',
  'in_production_date', 'in_freight_date',
] as const;

// Laravel 'required' (isEmpty): null/undefined/''/false/empty array.
function requiredFails(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
}

// PHP 7.4 loose equality for the types store()'s in_stock comparisons see
// (bool | number | string | null). PHP 7 string-vs-bool converts the string to
// a bool, so '0' == false is FALSE (PHP 8 would say true — the old app is 7.4).
function php7Eq(a: unknown, b: unknown): boolean {
  const zero = (v: unknown) => v === null || v === undefined || v === false || v === 0 || v === '';
  if (zero(a) && zero(b)) return true;
  if (zero(a) || zero(b)) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const toB = (v: unknown) => (typeof v === 'boolean' ? v : true);
    return toB(a) === toB(b);
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  const [n, s] = typeof a === 'number' ? ([a, String(b)] as const) : ([b, String(a)] as const);
  const t = s.trim();
  if (t !== '' && !Number.isNaN(Number(t))) return n === Number(t);
  return String(n) === s;
}

// New ProductLocation row (timestamps on: the table has created_at/updated_at).
async function insertProductLocation(values: Row): Promise<void> {
  const ts = nowDb();
  // SAFETY: full os_product_locations column set; runtime values mirror Eloquent.
  await db.insertInto('os_product_locations').values({ created_at: ts, updated_at: ts, ...values } as never).execute();
}

// ---------------------------------------------------------------- route actions (T27)

// Product@store (web.php:442 + api.php:40 — both hit this action; statement
// order from ProductController.php:103-362 is preserved, DB writes included).
async function store(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const p = (req.params as Record<string, string>)['id'];
  const hasId = p !== undefined && p !== '';
  const all = allInput(req);
  const has = (k: string): boolean => k in all;
  let bag: Row;
  let id: number | null = null;
  if (hasId) {
    id = Number(p);
    // Product::with('locations')->findOrfail($id) — the eager relations are
    // never read before save(); a bare row is enough.
    // SAFETY: full os_products row -> Record.
    const row = (await db.selectFrom('os_products').selectAll().where('id', '=', id).executeTakeFirst()) as unknown as Row;
    if (!row) return notFoundPage(reply);
    bag = { ...row };
  } else {
    // $this->validate: name required|unique:products,name|max:200;
    // sku required|unique:products,sku|max:20. All failed rules per field
    // are reported (Laravel collects every rule that fails).
    const errors: Record<string, string[]> = {};
    for (const [field, max] of [['name', 200], ['sku', 20]] as const) {
      const msgs: string[] = [];
      const v = all[field];
      if (requiredFails(v)) {
        msgs.push(`The ${field} field is required.`);
      } else {
        // SAFETY: count(*) projection.
        const [{ n }] = (await db.selectFrom('os_products').select(sql`count(*)`.as('n')).where(field, '=', String(v)).execute()) as { n: number }[];
        if (n > 0) msgs.push(`The ${field} has already been taken.`);
        // max uses mb_strlen (UTF-8 chars).
        if ([...String(v)].length > max) msgs.push(`The ${field} may not be greater than ${max} characters.`);
      }
      if (msgs.length > 0) errors[field] = msgs;
    }
    if (Object.keys(errors).length > 0) {
      const accept = req.headers['accept'];
      if (typeof accept === 'string' && accept.includes('application/json')) {
        // ValidationException 422 JSON for JSON-expecting requests.
        const first = Object.values(errors)[0][0];
        return reply.code(422).send({ message: first, errors });
      }
      // Flash errors + old input and redirect back, like the old app's
      // ValidationException handler for HTML requests.
      return redirectBack(req, reply).withErrors(errors).withInput({ ...all, password: undefined });
    }
    bag = {};
  }

  // $product->name/sku are assigned unconditionally (null on update = NULL).
  bag['name'] = all['name'] ?? null;
  bag['sku'] = all['sku'] ?? null;
  for (const k of STORE_FIELDS) {
    if (k === 'wholesale_category_list') {
      if (has(k) && Array.isArray(all[k])) bag[k] = (all[k] as unknown[]).join(',');
    } else if (has(k)) {
      bag[k] = all[k];
    }
  }
  let changeToOutOfStock = false;
  if (has('in_stock')) {
    if (!php7Eq(all['in_stock'], bag['in_stock']) && php7Eq(all['in_stock'], false)) changeToOutOfStock = true;
    bag['in_stock'] = all['in_stock'];
  }

  const ts = nowDb();
  if (id === null) {
    bag['created_at'] = ts;
    bag['updated_at'] = ts;
    // SAFETY: full os_products column set; runtime values mirror Eloquent.
    const res = await db.insertInto('os_products').values(bag as never).executeTakeFirst();
    id = Number(res.insertId);
  } else {
    const { id: _id, created_at: _c, updated_at: _u, ...cols } = bag;
    // SAFETY: os_products column set + timestamp; runtime values mirror Eloquent.
    await db.updateTable('os_products').set({ ...cols, updated_at: ts } as never).where('id', '=', id).execute();
  }

  const locations = Array.isArray(all['locations']) ? (all['locations'] as Row[]) : [];
  if (changeToOutOfStock) {
    // Eloquent Builder::update() stamps updated_at on every affected row.
    await db.updateTable('os_product_locations').set({ qty: 0, updated_at: ts } as never).where('product_id', '=', id).execute();
  } else if (hasId) {
    // $request->has('locations') (input('locations') may still be null — a
    // foreach over null is a no-op in PHP 7.4, mirrored by the Array.isArray).
    if (has('locations')) {
      for (const loc of locations) {
        if (String(loc['location'] ?? '').trim() === '') continue;
        if ('id' in loc && loc['id'] !== null) {
          // SAFETY: full os_product_locations rows -> Record.
          const rows = (await db.selectFrom('os_product_locations').selectAll().where('id', '=', loc['id'] as number).execute()) as unknown as Row[];
          for (const l of rows) {
            const cd = 'countdate' in loc && loc['countdate'] !== null ? loc['countdate'] : ts;
            // SAFETY: full row (see above).
            const lid = l['id'] as number;
            // SAFETY: runtime column values mirror the Eloquent attribute set.
            await db.updateTable('os_product_locations')
              .set({ location: loc['location'], qty: loc['qty'], countdate: cd, updated_at: ts } as never)
              .where('id', '=', lid)
              .execute();
          }
        } else {
          await insertProductLocation({ product_id: id, location: loc['location'], qty: loc['qty'] });
        }
      }
    }
  } else {
    for (const loc of locations) {
      if (String(loc['location'] ?? '').trim() === '') continue;
      await insertProductLocation({ product_id: id, location: loc['location'], qty: loc['qty'] });
    }
  }

  await mergeDuplicateLocations(id);
  // totalQty over non-PO locations (strpos is case-sensitive; null location -> '').
  const locs = await db.selectFrom('os_product_locations').select(['location', 'qty']).where('product_id', '=', id).execute();
  let totalQty = 0;
  for (const l of locs) {
    if (String(l.location ?? '').includes('PO')) continue;
    totalQty += Number(l.qty ?? 0);
  }
  // SAFETY: numeric + timestamp only.
  await db.updateTable('os_products').set({ qty: totalQty, updated_at: nowDb() } as never).where('id', '=', id).execute();
  reply.send(await productWithRelations(id));
}

// Product@deleteProduct (web.php:443).
async function deleteProduct(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await db.selectFrom('os_products').select(['id']).where('id', '=', id).executeTakeFirst();
  if (!product) return notFoundPage(reply); // findOrFail
  await db.deleteFrom('os_product_locations').where('product_id', '=', id).execute();
  await db.deleteFrom('os_products').where('id', '=', id).execute();
  jsonStr(reply, 'ok');
}

// Product@uploadMultipleImage (web.php:444).
async function uploadMultipleImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = String((req.params as Record<string, string>)['id']);
  const images: string[] = [];
  let counter = 0;
  if (req.isMultipart()) {
    for await (const part of req.parts()) {
      // SAFETY: multipart part shape (file part -> stream, field part -> value).
      const p = part as { fieldname: string; filename?: string; file?: unknown; value?: string; toBuffer: () => Promise<Buffer> };
      if (!p.file) {
        void p.value; // drain field parts
        continue;
      }
      if (p.fieldname !== 'files') continue;
      const buffer = await p.toBuffer();
      // getClientOriginalExtension(): pathinfo EXTENSION, case kept.
      const ext = (p.filename ?? '').split('.').pop() ?? '';
      const filePath = `${id}_${Math.floor(Date.now() / 1000)}_${counter}.${ext}`;
      await disk('product_image_full').put(filePath, await image(buffer).widen(1000, (c) => c.upsize()).stream());
      await disk('product_image_icon').put(filePath, await image(buffer).widen(100, (c) => c.upsize()).stream());
      // SAFETY: full os_product_images column set + timestamps.
      await db.insertInto('os_product_images')
        .values({ product_id: id, original_name: p.filename ?? '', filename: filePath, created_at: nowDb(), updated_at: nowDb() } as never)
        .execute();
      images.push(filePath);
      counter++;
    }
  }
  reply.send(images);
}

// Product@deleteImage (web.php:445): deletes ONLY the full-size file
// (the icon copy is orphaned — kept quirk).
async function deleteImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = req.params as Record<string, string>;
  // SAFETY: full os_product_images rows -> Record.
  const rows = (await db
    .selectFrom('os_product_images')
    .selectAll()
    .where('product_id', '=', params['id'])
    .where('id', '=', Number(params['image_id']))
    .execute()) as unknown as Row[];
  for (const r of rows) {
    await disk('product_image_full').delete(String(r['filename']));
    // SAFETY: PK reference.
    await db.deleteFrom('os_product_images').where('id', '=', r['id'] as number).execute();
  }
  jsonStr(reply, 'ok');
}

// Product@deleteLocation (web.php:447).
async function deleteLocation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = req.params as Record<string, string>;
  // SAFETY: full os_product_locations rows -> Record.
  const rows = (await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', Number(params['id']))
    .where('id', '=', Number(params['location_id']))
    .execute()) as unknown as Row[];
  if (rows.length > 0) {
    for (const r of rows) {
      // SAFETY: PK reference.
      await db.deleteFrom('os_product_locations').where('id', '=', r['id'] as number).execute();
    }
    await ensureDefaultStillStocked(Number(params['id']));
  }
  jsonStr(reply, 'ok');
}

// Product@updateLocations (web.php:448): the body is a JSON array of
// location objects; the create branch uses the body's product_id (quirk).
async function updateLocations(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = String((req.params as Record<string, string>)['id']);
  const body = req.body;
  const items: Row[] = Array.isArray(body) ? (body as Row[]) : body && typeof body === 'object' ? (Object.values(body) as Row[]) : [];
  for (const loc of items) {
    // SAFETY: full os_product_locations rows -> Record.
    const rows = (await db
      .selectFrom('os_product_locations')
      .selectAll()
      .where('product_id', '=', Number(id))
      .where('id', '=', loc['id'] as number)
      .execute()) as unknown as Row[];
    const ts = nowDb();
    const cd = loc['countdate'] ?? ts; // isset($location['countdate'])
    if (rows.length > 0) {
      for (const r of rows) {
        // SAFETY: PK reference; runtime values mirror the Eloquent attribute set.
        await db.updateTable('os_product_locations')
          .set({ location: loc['location'], packing: loc['packing'], carton: loc['carton'], qty: loc['qty'], countdate: cd, updated_at: ts } as never)
          .where('id', '=', r['id'] as number)
          .execute();
      }
    } else {
      // SAFETY: full os_product_locations column set.
      await db.insertInto('os_product_locations')
        .values({ product_id: loc['product_id'], location: loc['location'], qty: loc['qty'], packing: loc['packing'], carton: loc['carton'], countdate: cd, created_at: ts, updated_at: ts } as never)
        .execute();
    }
  }
  await mergeDuplicateLocations(Number(id));
  await ensureDefaultStillStocked(Number(id));
  // SAFETY: full os_product_locations rows -> Record (Eloquent serialises all columns).
  const rows = (await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', Number(id)).execute()) as unknown as Row[];
  reply.send(rows);
}

// Product@updateDefaultLocation (web.php:449).
async function updateDefaultLocation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  const location = String(input(req, 'location') ?? '').trim().toUpperCase();
  if (location === '') return reply.code(422).send({ success: false, message: 'location is required' });
  const product = await db.selectFrom('os_products').select(['id']).where('id', '=', id).executeTakeFirst();
  if (!product) return reply.code(404).send({ success: false, message: 'product not found' });
  await mergeDuplicateLocations(product.id);
  const bin = await db
    .selectFrom('os_product_locations')
    .select(['id', 'location'])
    .where('product_id', '=', product.id)
    .where(sql<boolean>`UPPER(TRIM(location)) = ${location}`)
    .executeTakeFirst();
  if (!bin) return reply.code(404).send({ success: false, message: 'location not found' });
  // SAFETY: string + timestamp only.
  await db.updateTable('os_products').set({ default_location: bin.location, updated_at: nowDb() } as never).where('id', '=', product.id).execute();
  reply.send({ success: true, default_location: bin.location });
}

// Product@updateLocationByLocId (web.php:460).
async function updateLocationByLocId(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const all = allInput(req);
  let returnId: unknown = all['id'];
  const sku = all['sku'];
  const p = (sku === null || sku === undefined)
    ? null
    : await db.selectFrom('os_products').select(['id']).where('sku', '=', String(sku)).executeTakeFirst();
  if (!p) return jsonStr(reply, 'sku not found', 500);
  const productId = p.id; // SAFETY: PK
  // PHP 7 `$input['id'] != null`: false for null, 0 and EVERY string.
  const rawId = all['id'];
  const idNotNull = rawId !== null && rawId !== undefined && rawId !== 0 && !(typeof rawId === 'string');
  if (idNotNull) {
    // SAFETY: full os_product_locations rows -> Record.
    const rows = (await db.selectFrom('os_product_locations').selectAll().where('id', '=', rawId as number).execute()) as unknown as Row[];
    for (const r of rows) {
      const ts = nowDb();
      // SAFETY: PK reference; runtime values mirror the Eloquent attribute set.
      await db.updateTable('os_product_locations')
        .set({
          location: String(all['location'] ?? '').toUpperCase(), // strtoupper — update branch only
          qty: all['qty'],
          packing: all['packing'],
          carton: all['carton'],
          countdate: ts,
          updated_at: ts,
        } as never)
        .where('id', '=', r['id'] as number)
        .execute();
    }
  } else {
    const ts = nowDb();
    // location is NOT uppercased in the insert branch (kept quirk).
    // SAFETY: full os_product_locations column set.
    const res = await db.insertInto('os_product_locations')
      .values({ product_id: productId, location: all['location'], qty: all['qty'], packing: all['packing'], carton: all['carton'], countdate: ts, created_at: ts, updated_at: ts } as never)
      .executeTakeFirst();
    returnId = Number(res.insertId);
  }
  await mergeDuplicateLocations(productId);
  await ensureDefaultStillStocked(productId);
  reply.send(returnId);
}

// Product@createAllThumbnail (web.php:450): GET that regenerates icon files;
// the action returns null -> 200 with an empty body.
async function createAllThumbnail(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // SAFETY: full os_product_images rows -> Record.
  const rows = (await db.selectFrom('os_product_images').selectAll().execute()) as unknown as Row[];
  const full = disk('product_image_full');
  const icon = disk('product_image_icon');
  for (const img of rows) {
    const filename = String(img['filename']);
    if (!(await full.exists(filename))) continue;
    const thumbnail = await image(await full.get(filename)).widen(100, (c) => c.upsize()).stream();
    if (await icon.exists(filename)) await icon.delete(filename);
    await icon.put(filename, thumbnail);
  }
  reply.send();
}

// Product@massUpdate (api.php:41): each field gets its own save() (one UPDATE
// per field, in this order); non-numeric values and missing products push to
// the failed list.
const MASS_UPDATE_FIELDS = ['price', 'wholesale_price', 'weight', 'length', 'width', 'height', 'cost', 'units_per_sale', 'wholesale_cat_id'];

async function massUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const failed: unknown[] = [];
  const products = input(req, 'products');
  if (Array.isArray(products)) {
    for (const item of products as Row[]) {
      const id = item['id'];
      const row = await db.selectFrom('os_products').select(['id']).where('id', '=', id as number).executeTakeFirst();
      if (!row) {
        // findOrFail inside the try -> caught by catch(Exception) -> failed.
        failed.push(id);
        continue;
      }
      // One UPDATE per field with its own save() (statement order kept).
      const save = async (k: string, v: unknown): Promise<void> => {
        // SAFETY: one os_products column + timestamp.
        await db.updateTable('os_products').set({ [k]: v, updated_at: nowDb() } as never).where('id', '=', id as number).execute();
      };
      for (const k of MASS_UPDATE_FIELDS) {
        // isset($product[k]): present and not null.
        if (!(k in item) || item[k] === null) continue;
        if (laravelNumeric(item[k])) await save(k, item[k]);
        else failed.push(id);
      }
      if ('wholesale_category_list' in item && item['wholesale_category_list'] !== null) {
        if (Array.isArray(item['wholesale_category_list'])) await save('wholesale_category_list', (item['wholesale_category_list'] as unknown[]).join(','));
        else failed.push(id);
      }
      if ('description' in item && item['description'] !== null) await save('description', item['description']);
    }
  }
  reply.send(failed);
}

// Product@massDelete (api.php:42).
async function massDelete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const failed: unknown[] = [];
  const ids = input(req, 'ids');
  if (Array.isArray(ids)) {
    for (const id of ids) {
      const product = await db.selectFrom('os_products').select(['id']).where('id', '=', id as number).executeTakeFirst();
      if (!product) {
        failed.push(id);
        continue;
      }
      await db.deleteFrom('os_product_locations').where('product_id', '=', id as number).execute();
      await db.deleteFrom('os_products').where('id', '=', id as number).execute();
    }
  }
  reply.send(failed);
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
  // web.php:442-450,460 — the product write APIs (session auth: same
  // intentional security change as the T26 api.php routes).
  route(app, { verb: 'post', path: '/api/product/{id?}', roles: ROLES, handler: store });
  route(app, { verb: 'delete', path: '/api/product/{id}', roles: ROLES, handler: deleteProduct });
  route(app, { verb: 'post', path: '/api/product/{id}/images', roles: ROLES, handler: uploadMultipleImage });
  route(app, { verb: 'delete', path: '/api/product/{id}/images/{image_id}', roles: ROLES, handler: deleteImage });
  route(app, { verb: 'delete', path: '/api/product/{id}/locations/{location_id}', roles: ROLES, handler: deleteLocation });
  route(app, { verb: 'post', path: '/api/product/{id}/locations', roles: ROLES, handler: updateLocations });
  route(app, { verb: 'post', path: '/api/product/{id}/default-location', roles: ROLES, handler: updateDefaultLocation });
  route(app, { verb: 'get', path: '/api/createAllThumbnail', roles: ROLES, handler: createAllThumbnail });
  route(app, { verb: 'post', path: '/api/location', roles: ROLES, handler: updateLocationByLocId });
  // api.php:40-42: the api.php copies of these routes (mounted at /api/*) hit
  // the same actions; web.php's registrations win first in Laravel, and only
  // the route NAMES from api.php are recorded here.
  registerRoute('product.store', '/api/product');
  route(app, { verb: 'post', path: '/api/products.update', name: 'products.update', roles: ROLES, handler: massUpdate });
  route(app, { verb: 'post', path: '/api/products.delete', name: 'products.delete', roles: ROLES, handler: massDelete });
}
