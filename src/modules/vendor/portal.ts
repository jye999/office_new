// Vendor portal: /vendor, /vendor/products/new and /vendor/products/{id} serve the Vue SPA (VendorProducts.vue /
// VendorProduct.vue, same look as the regular Product List / product modal); /vendor/api/* is its JSON API.
// A vendor user manages ONLY the products whose SKU is assigned to their vendor (os_sku_vendors). Everything is scoped
// by the logged-in user's vendor (os_vendor_users) — never by a client value.
// Vendors cannot see or change stock, locations or cost; the SKU is fixed once a product is created.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from '../../auth.js';
import { db, nowDb, sql } from '../../db.js';
import { allInput } from '../../http.js';
import { image } from '../../images.js';
import { route } from '../../router.js';
import { disk } from '../../storage.js';
import { render } from '../../view.js';

const ROLES = ['vendor'];

type Row = Record<string, unknown>;
interface Field {
  key: string;
  label: string;
  zh: string;
  kind: 'text' | 'textarea' | 'number' | 'status';
  max?: number;
  section: string;
}

// Editable product columns (besides name/sku). Deliberately excludes cost, stock/quantities, locations,
// in_production/in_freight and marketplace ids/links: internal-only.
export const PORTAL_FIELDS: Field[] = [
  { key: 'chinese', label: 'Chinese name', zh: '中文名称', kind: 'text', max: 250, section: 'Basic' },
  { key: 'upc', label: 'UPC', zh: 'UPC', kind: 'text', max: 20, section: 'Basic' },
  { key: 'vendor_sku', label: 'Vendor SKU', zh: '供应商 SKU', kind: 'text', max: 100, section: 'Basic' },
  { key: 'base_sku', label: 'Base SKU', zh: '基础 SKU', kind: 'text', max: 50, section: 'Basic' },
  { key: 'status', label: 'Status', zh: '状态', kind: 'status', section: 'Basic' },
  { key: 'description', label: 'Description', zh: '产品描述', kind: 'textarea', max: 10000, section: 'Basic' },
  { key: 'bullet_point_1', label: 'Bullet point 1', zh: '卖点 1', kind: 'text', max: 500, section: 'Bullet points' },
  { key: 'bullet_point_2', label: 'Bullet point 2', zh: '卖点 2', kind: 'text', max: 500, section: 'Bullet points' },
  { key: 'bullet_point_3', label: 'Bullet point 3', zh: '卖点 3', kind: 'text', max: 500, section: 'Bullet points' },
  { key: 'bullet_point_4', label: 'Bullet point 4', zh: '卖点 4', kind: 'text', max: 500, section: 'Bullet points' },
  { key: 'bullet_point_5', label: 'Bullet point 5', zh: '卖点 5', kind: 'text', max: 500, section: 'Bullet points' },
  { key: 'price', label: 'Retail price', zh: '零售价', kind: 'number', section: 'Pricing' },
  { key: 'wholesale_price', label: 'Wholesale price', zh: '批发价', kind: 'number', section: 'Pricing' },
  { key: 'length', label: 'Length', zh: '长', kind: 'number', section: 'Item size' },
  { key: 'width', label: 'Width', zh: '宽', kind: 'number', section: 'Item size' },
  { key: 'height', label: 'Height', zh: '高', kind: 'number', section: 'Item size' },
  { key: 'weight', label: 'Weight', zh: '重量', kind: 'number', section: 'Item size' },
  { key: 'package_length', label: 'Package length', zh: '包装长', kind: 'number', section: 'Package' },
  { key: 'package_width', label: 'Package width', zh: '包装宽', kind: 'number', section: 'Package' },
  { key: 'package_height', label: 'Package height', zh: '包装高', kind: 'number', section: 'Package' },
  { key: 'package_weightLb', label: 'Package weight (lb)', zh: '包装重量（磅）', kind: 'number', section: 'Package' },
  { key: 'package_weightOz', label: 'Package weight (oz)', zh: '包装重量（盎司）', kind: 'number', section: 'Package' },
  { key: 'units_per_pack', label: 'Units per pack', zh: '每包件数', kind: 'number', section: 'Package' },
  { key: 'units_per_sale', label: 'Units per sale', zh: '每次销售件数', kind: 'number', section: 'Package' },
  { key: 'qty_per_inner_box', label: 'Qty per inner box', zh: '每内盒数量', kind: 'number', section: 'Carton' },
  { key: 'qty_per_ctn', label: 'Qty per carton', zh: '每箱数量', kind: 'number', section: 'Carton' },
  { key: 'ctn_length', label: 'Carton length', zh: '外箱长', kind: 'number', section: 'Carton' },
  { key: 'ctn_width', label: 'Carton width', zh: '外箱宽', kind: 'number', section: 'Carton' },
  { key: 'ctn_height', label: 'Carton height', zh: '外箱高', kind: 'number', section: 'Carton' },
  { key: 'ctn_weightLb', label: 'Carton weight (lb)', zh: '外箱重量（磅）', kind: 'number', section: 'Carton' },
  { key: 'ctn_weightOz', label: 'Carton weight (oz)', zh: '外箱重量（盎司）', kind: 'number', section: 'Carton' },
  { key: 'ctn_cbm', label: 'Carton CBM', zh: '外箱体积（CBM）', kind: 'number', section: 'Carton' },
  { key: 'product_cbm', label: 'Product CBM', zh: '产品体积（CBM）', kind: 'number', section: 'Carton' },
];

const STATUSES = ['Active', 'InActive'];
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const clean = (v: unknown): string => String(v ?? '').trim();

// The logged-in vendor user's vendor id, or null (-> 403) when the user is not linked to a vendor.
async function myVendor(req: FastifyRequest): Promise<{ vendorId: number; vendorName: string; username: string } | null> {
  const auth = await currentUser(req);
  if (!auth.user) return null;
  const v = await db
    .selectFrom('os_vendor_users')
    .innerJoin('os_vendors', 'os_vendors.id', 'os_vendor_users.vendor_id')
    .select(['os_vendors.id as id', 'os_vendors.name as name'])
    .where('os_vendor_users.user_id', '=', auth.user.id)
    .executeTakeFirst();
  return v ? { vendorId: Number(v.id), vendorName: v.name, username: auth.user.username } : null;
}

// A product, only if its SKU is assigned to this vendor. Two queries (not a join): the two tables use different collations.
async function ownedProduct(vendorId: number, id: number): Promise<Row | null> {
  if (!Number.isInteger(id)) return null;
  const p = (await db.selectFrom('os_products').selectAll().where('id', '=', id).executeTakeFirst()) as unknown as Row | undefined;
  if (!p || typeof p['sku'] !== 'string' || p['sku'] === '') return null;
  const link = await db.selectFrom('os_sku_vendors').select('id').where('sku', '=', p['sku']).where('vendor_id', '=', vendorId).executeTakeFirst();
  return link ? p : null;
}

async function productImages(id: number): Promise<Row[]> {
  return (await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(id)).orderBy('id').execute()) as unknown as Row[];
}

// Parse + validate the editable fields from a form body. Returns the column values and per-field errors.
function parseFields(all: Row): { values: Row; errors: Record<string, string> } {
  const values: Row = {};
  const errors: Record<string, string> = {};
  for (const f of PORTAL_FIELDS) {
    if (!(f.key in all)) continue;
    const raw = clean(all[f.key]);
    if (f.kind === 'number') {
      if (raw === '') values[f.key] = null;
      else if (!Number.isFinite(Number(raw)) || Number(raw) < 0) errors[f.key] = `${f.zh}必须是不小于 0 的数字`;
      else values[f.key] = Number(raw);
    } else if (f.kind === 'status') {
      if (!STATUSES.includes(raw)) errors[f.key] = '状态必须是启用或停用';
      else values[f.key] = raw;
    } else {
      if ([...raw].length > (f.max ?? 250)) errors[f.key] = `${f.zh}太长（最多 ${f.max} 个字符）`;
      else values[f.key] = raw === '' ? null : raw;
    }
  }
  return { values, errors };
}

async function nameTaken(name: string, exceptId = 0): Promise<boolean> {
  return (await db.selectFrom('os_products').select('id').where('name', '=', name).where('id', '!=', exceptId).executeTakeFirst()) != null;
}

async function skuTaken(sku: string): Promise<boolean> {
  const inProducts = await db.selectFrom('os_products').select('id').where('sku', '=', sku).executeTakeFirst();
  const inVendors = await db.selectFrom('os_sku_vendors').select('id').where('sku', '=', sku).executeTakeFirst();
  return inProducts != null || inVendors != null;
}

// Columns returned to the vendor UI (never cost, stock, locations, marketplace links...).
const PRODUCT_COLUMNS = ['id', 'sku', 'name', ...PORTAL_FIELDS.map((f) => f.key)] as const;

function vendorProductJson(p: Row, images: Row[]): Row {
  const out: Row = {};
  for (const c of PRODUCT_COLUMNS) out[c] = p[c] ?? null;
  out['weight_unit'] = p['weight_unit'] ?? null;
  out['images'] = images.map((i) => ({ id: i['id'], filename: i['filename'] }));
  return out;
}

// ---------------------------------------------------------------- handlers (JSON API)

function validationError(reply: FastifyReply, errors: Record<string, string>): void {
  reply.code(422).send({ success: false, message: Object.values(errors)[0], errors });
}

async function apiMe(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  reply.send({ vendor_name: me.vendorName, username: me.username });
}

async function apiList(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const q = clean(allInput(req)['q']);
  // Every SKU assigned to this vendor, then those products (bounded by the vendor's own catalogue).
  const links = await db.selectFrom('os_sku_vendors').select('sku').where('vendor_id', '=', me.vendorId).execute();
  const skus = links.map((l) => l.sku);
  let products: Row[] = [];
  if (skus.length > 0) {
    let query = db.selectFrom('os_products').select(['id', 'sku', 'name', 'price', 'status', 'upc', 'vendor_sku']).where('sku', 'in', skus);
    if (q !== '') {
      const like = `%${q}%`;
      query = query.where((eb) => eb.or([eb('name', 'like', like), eb('sku', 'like', like), eb('vendor_sku', 'like', like), eb('upc', 'like', like)]));
    }
    products = (await query.orderBy('id', 'desc').limit(500).execute()) as unknown as Row[];
  }
  const ids = products.map((p) => String(p['id']));
  const imgs = ids.length ? await db.selectFrom('os_product_images').select(['product_id', 'filename']).where('product_id', 'in', ids).orderBy('id').execute() : [];
  const firstImage = new Map<string, string>();
  for (const i of imgs) if (!firstImage.has(String(i.product_id))) firstImage.set(String(i.product_id), i.filename);
  for (const p of products) p['image'] = firstImage.get(String(p['id'])) ?? null;
  reply.send({ total: skus.length, products });
}

async function apiShow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await ownedProduct(me.vendorId, id);
  if (!product) return notFound(reply);
  reply.send(vendorProductJson(product, await productImages(id)));
}

async function apiCreate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const all = allInput(req);
  const name = clean(all['name']);
  const sku = clean(all['sku']);
  const { values, errors } = parseFields(all);
  if (name === '') errors['name'] = '请填写产品名称';
  else if ([...name].length > 200) errors['name'] = '产品名称太长（最多 200 个字符）';
  else if (await nameTaken(name)) errors['name'] = '已存在同名产品';
  if (sku === '') errors['sku'] = '请填写 SKU';
  else if ([...sku].length > 20) errors['sku'] = 'SKU 太长（最多 20 个字符）';
  else if (await skuTaken(sku)) errors['sku'] = '该 SKU 已被使用';
  if (Object.keys(errors).length > 0) return validationError(reply, errors);
  const now = nowDb();
  const id = await db.transaction().execute(async (trx) => {
    const res = await trx
      .insertInto('os_products')
      .values({ ...values, name, sku, status: values['status'] ?? 'Active', entry_by: `vendor:${me.username}`.slice(0, 50), created_at: now, updated_at: now } as never)
      .executeTakeFirst();
    await trx.insertInto('os_sku_vendors').values({ sku, vendor_id: me.vendorId, created_at: now, updated_at: now } as never).execute();
    return Number(res.insertId);
  });
  const created = (await ownedProduct(me.vendorId, id)) as Row;
  reply.code(201).send(vendorProductJson(created, []));
}

async function apiUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await ownedProduct(me.vendorId, id);
  if (!product) return notFound(reply);
  const all = allInput(req);
  const name = clean(all['name']);
  const { values, errors } = parseFields(all);
  if (name === '') errors['name'] = '请填写产品名称';
  else if ([...name].length > 200) errors['name'] = '产品名称太长（最多 200 个字符）';
  else if (await nameTaken(name, id)) errors['name'] = '已存在同名产品';
  if (Object.keys(errors).length > 0) return validationError(reply, errors);
  // `sku` is never updated: it keys orders/inventory and the vendor assignment.
  await db.updateTable('os_products').set({ ...values, name, updated_at: nowDb() } as never).where('id', '=', id).execute();
  reply.send(vendorProductJson((await ownedProduct(me.vendorId, id)) as Row, await productImages(id)));
}

async function apiDelete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await ownedProduct(me.vendorId, id);
  if (!product) return notFound(reply);
  // Warehouse stock must be handled by staff: never delete a product that has stock.
  const stock = await db.selectFrom('os_product_locations').select(sql<number>`coalesce(sum(qty), 0)`.as('n')).where('product_id', '=', id).executeTakeFirst();
  if (Number(stock?.n ?? 0) > 0) return void reply.code(409).send({ success: false, message: '该产品在仓库有库存，无法删除。请联系我们处理。' });
  const images = await productImages(id);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('os_product_locations').where('product_id', '=', id).execute();
    await trx.deleteFrom('os_product_images').where('product_id', '=', String(id)).execute();
    await trx.deleteFrom('os_sku_vendors').where('sku', '=', String(product['sku'])).where('vendor_id', '=', me.vendorId).execute();
    await trx.deleteFrom('os_products').where('id', '=', id).execute();
  });
  for (const img of images) {
    for (const d of ['product_image_full', 'product_image_icon']) await disk(d).delete(String(img['filename'])).catch(() => false);
  }
  reply.send({ success: true });
}

async function apiUploadImages(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await ownedProduct(me.vendorId, id);
  if (!product) return notFound(reply);
  let counter = 0;
  let rejected = 0;
  if (req.isMultipart()) {
    for await (const part of req.parts()) {
      const p = part as { fieldname: string; filename?: string; file?: unknown; toBuffer: () => Promise<Buffer> };
      if (!p.file) continue;
      // The regular product uploader posts `files[]`.
      if (p.fieldname !== 'files' && p.fieldname !== 'files[]') continue;
      const buffer = await p.toBuffer();
      const ext = ((p.filename ?? '').split('.').pop() ?? '').toLowerCase();
      if (!IMAGE_EXT.has(ext) || buffer.length === 0) {
        rejected++;
        continue;
      }
      const filePath = `${id}_${Math.floor(Date.now() / 1000)}_${counter}.${ext}`;
      await disk('product_image_full').put(filePath, await image(buffer).widen(1000, (c) => c.upsize()).stream());
      await disk('product_image_icon').put(filePath, await image(buffer).widen(100, (c) => c.upsize()).stream());
      await db.insertInto('os_product_images').values({ product_id: String(id), original_name: (p.filename ?? '').slice(0, 250), filename: filePath, created_at: nowDb(), updated_at: nowDb() } as never).execute();
      counter++;
    }
  }
  reply.send({ success: true, uploaded: counter, rejected, images: (await productImages(id)).map((i) => ({ id: i['id'], filename: i['filename'] })) });
}

async function apiDeleteImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = await myVendor(req);
  if (!me) return deny(reply);
  const params = req.params as Record<string, string>;
  const id = Number(params['id']);
  const product = await ownedProduct(me.vendorId, id);
  if (!product) return notFound(reply);
  const imageId = Number(params['imageId']);
  const img = Number.isInteger(imageId)
    ? ((await db.selectFrom('os_product_images').selectAll().where('id', '=', imageId).where('product_id', '=', String(id)).executeTakeFirst()) as unknown as Row | undefined)
    : undefined;
  if (!img) return notFound(reply);
  await db.deleteFrom('os_product_images').where('id', '=', imageId).execute();
  for (const d of ['product_image_full', 'product_image_icon']) await disk(d).delete(String(img['filename'])).catch(() => false);
  reply.send({ success: true });
}

function deny(reply: FastifyReply): void {
  reply.code(403).send({ success: false, message: '无权访问' });
}

function notFound(reply: FastifyReply): void {
  reply.code(404).send({ success: false, message: '未找到' });
}

// The Vue SPA shell (same page the regular Product List uses) — the bundle routes /vendor/* itself.
async function shell(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await myVendor(req))) return void reply.code(403).type('text/html; charset=UTF-8').send('No Access.');
  await render(req, reply, 'product/vue', { title: 'vendor' });
}

export function registerVendorPortalRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/vendor', name: 'vendor.portal', roles: ROLES, handler: shell });
  route(app, { verb: 'get', path: '/vendor/products/new', roles: ROLES, handler: shell });
  route(app, { verb: 'get', path: '/vendor/products/{id}', roles: ROLES, handler: shell });
  route(app, { verb: 'get', path: '/vendor/api/me', roles: ROLES, handler: apiMe });
  route(app, { verb: 'get', path: '/vendor/api/products', roles: ROLES, handler: apiList });
  route(app, { verb: 'post', path: '/vendor/api/products', roles: ROLES, handler: apiCreate });
  route(app, { verb: 'get', path: '/vendor/api/products/{id}', roles: ROLES, handler: apiShow });
  route(app, { verb: 'post', path: '/vendor/api/products/{id}', roles: ROLES, handler: apiUpdate });
  route(app, { verb: 'delete', path: '/vendor/api/products/{id}', roles: ROLES, handler: apiDelete });
  route(app, { verb: 'post', path: '/vendor/api/products/{id}/images', roles: ROLES, handler: apiUploadImages });
  route(app, { verb: 'delete', path: '/vendor/api/products/{id}/images/{imageId}', roles: ROLES, handler: apiDeleteImage });
}
