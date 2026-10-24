// J5: Runner.php actions matching /shopify/ that are scheduled (uncommented) in Kernel.php:
// shopify (GetShopify), upload-shopify (UploadShopify) and shopify-products (RefreshShopifyProducts).
// etsy-shopify/etsy2-shopify (CopyAllEtsyToShopify) are commented out in Kernel.php and invoked by no
// route/page, so they stay unregistered (Runner's silent unknown-action no-op).
// Every Shopify request and DB write is skipped under DRY_RUN=1 at the action level (the lib also blocks
// non-GET calls itself).
// Skipped: RefreshShopifyProducts' `admin/products/count.json` call - its result is only logged.

import { db, nowDb, sql } from '../../db.js';
import { Shopify } from '../../lib/shopify.js';
import { date, strtotime } from '../../view.js';

const dryRun = () => process.env.DRY_RUN === '1';
const quietDryRun = (action: string) => {
  console.info(`[DRY_RUN] sync ${action}: Shopify request and DB writes skipped`);
  return 0;
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)); // PHP (string) cast
// PHP isset($arr[$k]) / array_key_exists helper: key present and not null.
const has = (o: any, k: string): boolean => o != null && typeof o === 'object' && o[k] != null;
// PHP foreach over a non-array raises an ErrorException in Laravel (command fails).
function list(v: unknown): any[] {
  if (!Array.isArray(v)) throw new Error('foreach() argument must be of type array|object');
  return v;
}

// ---- GetShopify ----

async function getShopify(): Promise<void> {
  const shopify = new Shopify();
  const orders = list(await shopify.call('GET', 'admin/orders.json', { limit: '250', financial_status: 'paid', fulfillment_status: 'unshipped' }));

  const grantOrder: Record<string, unknown>[] = [];
  const grantOrderDetail: Record<string, unknown>[] = [];
  for (const order of orders) {
    const name = str(order.name);
    const o = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', name).where('store', '=', 'S').executeTakeFirst();
    if (!o) {
      const ship = has(order, 'shipping_address') ? order.shipping_address : null;
      grantOrder.push({
        store: 'S',
        orderId: name,
        purchaseDate: date('Y-m-d H:i:s', strtotime(order.created_at)),
        buyer: has(order, 'customer') ? `${order.customer.first_name} ${order.customer.last_name}` : '',
        email: str(order.email),
        recipientName: ship ? `${ship.first_name} ${ship.last_name}` : '',
        address1: ship ? str(ship.address1) : '',
        address2: ship ? str(ship.address2) : '',
        city: ship ? str(ship.city) : '',
        state: ship ? str(ship.province_code) : '',
        zip: ship ? str(ship.zip) : '',
        country: ship ? str(ship.country_code) : '',
        phone: ship ? str(ship.phone) : '',
        notesFromBuyer: str(order.note),
        tax: order.total_tax,
        discount: order.total_discounts,
        total: order.total_price,
      });
      let shipLevel = '';
      for (const sl of list(order.shipping_lines)) shipLevel = sl.title;
      for (const li of list(order.line_items)) {
        const existing = await db
          .selectFrom('os_grant_orderdetail').select('id').where('orderId', '=', name).where('itemId', '=', str(li.product_id)).where('store', '=', 'S').executeTakeFirst();
        if (existing) continue;
        const pImage = await shopify.call('GET', `admin/products/${li.product_id}.json`);
        grantOrderDetail.push({
          store: 'S',
          orderId: name,
          subOrderId: `${order.id}-${li.product_id}`,
          itemId: `${order.id}-${li.product_id}`,
          asin: str(li.product_id),
          name: str(li.title),
          qty: li.quantity,
          price: li.price,
          variation: str(li.variant_title),
          shipLevel,
          image: has(pImage, 'image') ? str(pImage.image.src) : '',
        });
      }
    } else if (o.status === 'Done') {
      console.info(`found order ${name}is in shopify but status show Done, reset to submit `);
      await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: nowDb() as never }).where('id', '=', o.id).execute();
    }
  }
  // GrantOrder::insert / GrantOrderDetail::insert (query builder: no timestamps added).
  if (grantOrder.length > 0) await db.insertInto('os_grant_order').values(grantOrder as never).execute();
  if (grantOrderDetail.length > 0) await db.insertInto('os_grant_orderdetail').values(grantOrderDetail as never).execute();
  console.info(`shopify done , new orders : ${grantOrder.length}`);
}

// ---- UploadShopify ----

async function uploadShopify(): Promise<void> {
  console.log('upload shopify tracking');
  const orders = await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'S').where('status', '=', 'submit').execute();
  const shopify = new Shopify();
  for (const o of orders) {
    console.log(o.orderId);
    // foreach ($o->tracking): the last row wins.
    let tracking = '';
    for (const t of await db.selectFrom('os_trackings').selectAll().where('orderId', '=', o.orderId).execute()) tracking = t.tracking ?? '';
    // foreach ($o->detail): the last row's subOrderId prefix is the Shopify order id.
    let realId = '';
    for (const od of await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', o.orderId).execute()) realId = (od.subOrderId ?? '').split('-')[0];
    const carrier = tracking.startsWith('Z') ? 'USP' : tracking.length > 12 ? 'USPS' : 'Fedex';
    const data = { fulfillment: { location_id: '633372696', tracking_number: tracking, tracking_company: carrier } };
    console.info(`upload shopify ${o.orderId}`);
    await shopify.call('POST', `admin/orders/${realId}/fulfillments.json`, data);
    // PHP: `!isset($r['errors']) || strpos(...) >= 0` - strpos() is false or an int, both >= 0 under PHP 7.4
    // loose comparison, so the order is marked Done whatever Shopify replied.
    await db.updateTable('os_grant_order').set({ status: 'Done', updated_at: nowDb() as never }).where('id', '=', o.id).execute();
  }
  console.info('upload shopify done');
}

// ---- RefreshShopifyProducts ----

// new Carbon($iso) keeps the string's own wall clock; Eloquent saves that wall clock. null -> now.
const carbon = (v: unknown): string => (v ? String(v).slice(0, 19).replace('T', ' ') : nowDb());

// Next page URL from the `Link` header (rel="next"), '' when there is none.
export function nextPageLink(link: string | undefined): string {
  for (const l of (link ?? '').split(',')) {
    if (l.includes('"next"')) {
      const m = /<(.*?)>/.exec(l);
      if (m) return m[1];
    }
  }
  return '';
}

export async function fetchShopifyProducts(shopify: Shopify): Promise<any[]> {
  const all: any[] = [];
  let next = 'https://angel-isabella.myshopify.com/admin/products.json?limit=250';
  while (next !== '') {
    const products = list(await shopify.call('GET', `admin/products.json?${new URL(next).search.slice(1)}`, []));
    all.push(...products);
    next = nextPageLink(shopify.lastResponseHeaders?.link);
  }
  return all;
}

export function shopifyProductRows(p: any) {
  return {
    product: {
      id: p.id, title: p.title, body_html: p.body_html, created_at: carbon(p.created_at), handle: p.handle,
      product_type: p.product_type, published_at: carbon(p.published_at), published_scope: p.published_scope, tags: p.tags,
      updated_at: carbon(p.updated_at), vendor: p.vendor, image: p.image?.id ?? null,
    },
    variants: list(p.variants).map((v) => ({
      id: v.id, barcode: v.barcode, fulfillment_service: v.fulfillment_service, created_at: carbon(v.created_at), grams: v.grams,
      weight: v.weight, weight_unit: v.weight_unit, inventory_management: v.inventory_management, inventory_policy: v.inventory_policy,
      inventory_quantity: v.inventory_quantity, option1: v.option1, option2: v.option2, option3: v.option3, position: v.position,
      price: v.price, product_id: v.product_id, requires_shipping: v.requires_shipping, sku: v.sku, taxable: v.taxable, title: v.title,
      updated_at: carbon(v.updated_at), image_id: v.image_id,
    })),
    images: list(p.images).map((img) => ({
      id: img.id, product_id: img.product_id, position: img.position, created_at: carbon(img.created_at),
      updated_at: carbon(img.updated_at), width: img.width, height: img.height, src: img.src,
    })),
  };
}

async function refreshShopifyProducts(): Promise<void> {
  const shopify = new Shopify();
  // PHP truncates first, then fetches page by page and saves as it goes.
  for (const t of ['os_shopify_products', 'os_shopify_products_images', 'os_shopify_products_variants'] as const) {
    await sql.raw(`truncate ${t}`).execute(db);
  }
  const products = await fetchShopifyProducts(shopify);
  for (const p of products) {
    const { product, variants, images } = shopifyProductRows(p);
    await db.insertInto('os_shopify_products').values(product as never).execute();
    for (const v of variants) await db.insertInto('os_shopify_products_variants').values(v as never).execute();
    for (const img of images) await db.insertInto('os_shopify_products_images').values(img as never).execute();
  }
  // updateReportTime('shopifyrefresh')
  const now = nowDb();
  const existing = await db.selectFrom('os_report_time').select('id').where('reportName', '=', 'shopifyrefresh').executeTakeFirst();
  const values = { requestId: '', requestTime: now as never, updated_at: now as never };
  if (existing) await db.updateTable('os_report_time').set(values).where('id', '=', existing.id).execute();
  else await db.insertInto('os_report_time').values({ ...values, reportName: 'shopifyrefresh', created_at: now as never }).execute();
  console.info(' refresh shopify products done');
}

export const shopifyActions: Record<string, (arg1?: string) => Promise<number>> = {
  shopify: async () => { if (dryRun()) return quietDryRun('shopify'); await getShopify(); return 0; },
  'upload-shopify': async () => { if (dryRun()) return quietDryRun('upload-shopify'); await uploadShopify(); return 0; },
  'shopify-products': async () => { if (dryRun()) return quietDryRun('shopify-products'); await refreshShopifyProducts(); return 0; },
};
