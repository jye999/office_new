// J5: Runner Shopify/Houzz sync actions (shopify, upload-shopify, shopify-products, houzz). Nothing reaches
// shopify.com or houzz.com: both transports are mocked; DB tests use J5T-prefixed temp rows deleted in afterEach.
// shopify-products truncates shared tables, so only its pure fetch/map helpers run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { actions, runSyncAction } from '../src/jobs/actions.js';
import { fetchShopifyProducts, nextPageLink, shopifyProductRows } from '../src/jobs/actions/shopify.js';
import { setHouzzTransportForTests, type HouzzRequest } from '../src/lib/houzz.js';
import { setShopifyTransportForTests, Shopify, type ShopifyRequest } from '../src/lib/shopify.js';

const actionNames = ['shopify', 'upload-shopify', 'shopify-products', 'houzz'];
// Commented out in Kernel.php and invoked by no route/page: must stay the silent no-op.
const unported = ['etsy', 'etsy2', 'etsy3', 'etsy-token', 'etsy-listings', 'upload-etsy-tracking', 'upload-etsy-tracking2', 'etsy-shopify', 'etsy2-shopify'];

let shopifySent: ShopifyRequest[];
let shopifyReplies: Record<string, object>; // by "METHOD /path" prefix, longest wins
let houzzSent: HouzzRequest[];
let houzzReplies: Record<string, object>; // by method name; getOrders by 'getOrders:<Status>'

beforeEach(() => {
  Object.assign(process.env, { SHOPIFY_DOMAIN: 'j5shop', SHOPIFY_API_KEY: 'k', SHOPIFY_PASSWORD: 'p' });
  delete process.env.DRY_RUN;
  shopifySent = [];
  shopifyReplies = {};
  houzzSent = [];
  houzzReplies = {};
  setShopifyTransportForTests(async (req) => {
    shopifySent.push(req);
    const u = new URL(req.url);
    const key = `${req.method} ${u.pathname}`;
    const hit = Object.keys(shopifyReplies).filter((k) => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return { status: 200, reason: 'OK', headers: {}, body: JSON.stringify(hit ? shopifyReplies[hit] : {}) };
  });
  setHouzzTransportForTests(async (req) => {
    houzzSent.push(req);
    const q = new URL(req.url).searchParams;
    const key = q.get('method') === 'getOrders' ? `getOrders:${q.get('Status')}` : (q.get('method') ?? '');
    return JSON.stringify(houzzReplies[key] ?? { Ack: 'Failure' });
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  setShopifyTransportForTests(null);
  setHouzzTransportForTests(null);
  delete process.env.DRY_RUN;
  vi.restoreAllMocks();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'J5T%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'J5T%').execute();
  await db.deleteFrom('os_trackings').where('orderId', 'like', 'J5T%').execute();
  await db.deleteFrom('os_product_images').where('filename', 'like', 'J5T%').execute();
  await db.deleteFrom('os_products').where('amazon_sku', 'like', 'J5T%').execute();
});

const insertOrder = (store: string, orderId: string, status: string | null) =>
  db.insertInto('os_grant_order').values({ store, orderId, status, created_at: nowDb() as never, updated_at: nowDb() as never }).execute();
const orderStatus = async (orderId: string) =>
  (await db.selectFrom('os_grant_order').select('status').where('orderId', '=', orderId).executeTakeFirst())?.status;

describe('J5 Shopify/Houzz sync actions', () => {
  it('registers every J5 action; DRY_RUN makes no request or DB write', async () => {
    process.env.DRY_RUN = '1';
    for (const action of actionNames) {
      expect(actions.has(action), action).toBe(true);
      await expect(runSyncAction(action)).resolves.toBe(0);
    }
    expect(vi.mocked(console.info).mock.calls.filter(([m]) => String(m).includes('[DRY_RUN]'))).toHaveLength(4);
    expect(shopifySent).toHaveLength(0);
    expect(houzzSent).toHaveLength(0);
  });

  it('commented-out Etsy actions stay the silent unknown-action no-op', async () => {
    for (const action of unported) {
      expect(actions.has(action), action).toBe(false);
      await expect(runSyncAction(action)).resolves.toBe(0);
    }
    expect(shopifySent).toHaveLength(0);
    expect(vi.mocked(console.info).mock.calls).toHaveLength(0);
  });

  it('shopify: inserts a new order + details, resets a Done order, skips known details', async () => {
    await insertOrder('S', 'J5T-DONE', 'Done');
    shopifyReplies['GET /admin/orders.json'] = {
      orders: [
        {
          id: 9001, name: 'J5T-NEW', created_at: '2024-03-01T10:00:00-05:00', customer: { first_name: 'A', last_name: 'B' }, email: 'a@b.c',
          shipping_address: { first_name: 'A', last_name: 'B', address1: '1 St', address2: null, city: 'X', province_code: 'NY', zip: '10001', country_code: 'US', phone: '555' },
          note: null, total_tax: '1.00', total_discounts: '0.00', total_price: '11.00',
          shipping_lines: [{ title: 'Ground' }],
          line_items: [{ product_id: 77, title: 'Vase', quantity: 2, price: '5.00', variant_title: 'Blue' }],
        },
        { id: 9002, name: 'J5T-DONE', created_at: '2024-03-01T10:00:00-05:00', shipping_lines: [], line_items: [] },
      ],
    };
    shopifyReplies['GET /admin/products/77.json'] = { product: { image: { src: 'https://img/x.jpg' } } };

    expect(await runSyncAction('shopify')).toBe(0);

    const order = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', 'J5T-NEW').executeTakeFirstOrThrow();
    expect(order).toMatchObject({ store: 'S', buyer: 'A B', email: 'a@b.c', address1: '1 St', address2: '', state: 'NY', notesFromBuyer: '', purchaseDate: '2024-03-01 10:00:00' });
    expect(Number(order.total)).toBe(11);
    const detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', 'J5T-NEW').executeTakeFirstOrThrow();
    expect(detail).toMatchObject({ store: 'S', subOrderId: '9001-77', itemId: '9001-77', asin: '77', name: 'Vase', qty: 2, variation: 'Blue', shipLevel: 'Ground', image: 'https://img/x.jpg' });
    expect(await orderStatus('J5T-DONE')).toBe('submit');
    expect(shopifySent.every((r) => r.method === 'GET')).toBe(true);

    // Second run: the order exists, nothing new is inserted.
    await runSyncAction('shopify');
    expect(await db.selectFrom('os_grant_order').select('id').where('orderId', '=', 'J5T-NEW').execute()).toHaveLength(1);
    expect(await db.selectFrom('os_grant_orderdetail').select('id').where('orderId', '=', 'J5T-NEW').execute()).toHaveLength(1);
  });

  it('upload-shopify: POSTs a fulfillment with the carrier guess and marks Done', async () => {
    await insertOrder('S', 'J5T-UP1', 'submit');
    await insertOrder('S', 'J5T-UP2', 'submit');
    await insertOrder('S', 'J5T-SKIP', 'Done');
    await db.insertInto('os_grant_orderdetail').values({ store: 'S', orderId: 'J5T-UP1', itemId: '5-1', subOrderId: '5-1', name: 'n', qty: 1 } as never).execute();
    await db.insertInto('os_grant_orderdetail').values({ store: 'S', orderId: 'J5T-UP2', itemId: '6-1', subOrderId: '6-1', name: 'n', qty: 1 } as never).execute();
    await db.insertInto('os_trackings').values({ orderId: 'J5T-UP1', tracking: '9400111899223344556677', Url: '', created_at: nowDb() as never, updated_at: nowDb() as never }).execute();
    await db.insertInto('os_trackings').values({ orderId: 'J5T-UP2', tracking: '123456789012', Url: '', created_at: nowDb() as never, updated_at: nowDb() as never }).execute();

    expect(await runSyncAction('upload-shopify')).toBe(0);

    const posts = shopifySent.filter((r) => r.method === 'POST' && r.url.includes('/fulfillments.json'));
    const bodies = new Map(posts.map((r) => [new URL(r.url).pathname, JSON.parse(r.body!).fulfillment]));
    expect(bodies.get('/admin/orders/5/fulfillments.json')).toEqual({ location_id: '633372696', tracking_number: '9400111899223344556677', tracking_company: 'USPS' });
    expect(bodies.get('/admin/orders/6/fulfillments.json')).toMatchObject({ tracking_company: 'Fedex' });
    expect(await orderStatus('J5T-UP1')).toBe('Done');
    expect(await orderStatus('J5T-UP2')).toBe('Done');
    expect(await orderStatus('J5T-SKIP')).toBe('Done');
  });

  it('shopify-products helpers: follow rel="next" links and map product/variant/image rows', async () => {
    expect(nextPageLink('<https://s/admin/products.json?page_info=a>; rel="previous", <https://s/admin/products.json?page_info=b&limit=250>; rel="next"')).toBe(
      'https://s/admin/products.json?page_info=b&limit=250',
    );
    expect(nextPageLink(undefined)).toBe('');

    const p = {
      id: 1, title: 'T', body_html: '<p>', created_at: '2024-03-01T10:00:00-05:00', handle: 'h', product_type: 'pt', published_at: '2024-03-02T11:00:00-05:00',
      published_scope: 'web', tags: 'a', updated_at: '2024-03-03T12:00:00-05:00', vendor: 'v', image: null,
      variants: [{ id: 2, product_id: 1, created_at: '2024-03-01T10:00:00-05:00', updated_at: '2024-03-01T10:00:00-05:00', sku: 'S' }],
      images: [{ id: 3, product_id: 1, created_at: '2024-03-01T10:00:00-05:00', updated_at: '2024-03-01T10:00:00-05:00', src: 'u' }],
    };
    const pages: Record<string, { products: unknown[]; link?: string }> = {
      '': { products: [p], link: '<https://j5shop.myshopify.com/admin/products.json?page_info=zz&limit=250>; rel="next"' },
      zz: { products: [{ ...p, id: 4 }] },
    };
    setShopifyTransportForTests(async (req) => {
      const page = pages[new URL(req.url).searchParams.get('page_info') ?? ''];
      return { status: 200, reason: 'OK', headers: page.link ? { link: page.link } : ({} as Record<string, string>), body: JSON.stringify({ products: page.products }) };
    });
    const all = await fetchShopifyProducts(new Shopify());
    expect(all.map((x) => x.id)).toEqual([1, 4]);

    const rows = shopifyProductRows(p);
    expect(rows.product).toMatchObject({ id: 1, image: null, created_at: '2024-03-01 10:00:00', published_at: '2024-03-02 11:00:00' });
    expect(rows.variants[0]).toMatchObject({ id: 2, sku: 'S', created_at: '2024-03-01 10:00:00' });
    expect(rows.images[0]).toMatchObject({ id: 3, src: 'u' });
  });

  it('houzz: ships Done orders (any store, not already Done) and imports new unshipped orders with the main image', async () => {
    await insertOrder('H', 'J5T-H-SHIPPED', 'submit');
    await insertOrder('H', 'J5T-H-EXISTS', 'submit');
    const prod = await db.insertInto('os_products').values({ sku: 'J5T-P', amazon_sku: 'J5T-SKU' } as never).executeTakeFirst();
    await db.insertInto('os_product_images').values({ product_id: String(prod.insertId), filename: 'J5T-main.jpg', original_name: 'o' }).execute();
    houzzReplies['getOrders:Shipped'] = { Ack: 'Success', Orders: [{ OrderId: 'J5T-H-SHIPPED' }] };
    houzzReplies['getOrders:Active'] = {
      Ack: 'Success',
      Orders: [
        {
          OrderId: 'J5T-H-NEW', Created: '2024-03-01 10:00:00', CustomerName: 'Cust', OrderTotal: '20.50',
          Address: { Address1: '1 St', City: 'X', State: 'NY', Zip: '10001' },
          OrderItems: [{ ProductId: 'HP1', SKU: 'J5T-SKU', Title: 'Lamp', Quantity: '3', Cost: '6.50' }],
        },
        { OrderId: 'J5T-H-EXISTS', Created: '2024-03-01 10:00:00', OrderItems: [] },
      ],
    };
    houzzReplies.getListing = { Ack: 'Success' };

    expect(await runSyncAction('houzz')).toBe(0);

    expect(houzzSent.every((r) => r.method === 'GET')).toBe(true);
    expect(houzzSent.some((r) => r.url.includes('method=updateOrder'))).toBe(false); // houzz never ships to Houzz
    expect(await orderStatus('J5T-H-SHIPPED')).toBe('Done');
    expect(await orderStatus('J5T-H-EXISTS')).toBe('submit');
    const order = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', 'J5T-H-NEW').executeTakeFirstOrThrow();
    expect(order).toMatchObject({ store: 'H', buyer: 'Cust', address2: '', country: 'US', purchaseDate: '2024-03-01 10:00:00' });
    expect(Number(order.total)).toBe(20.5);
    const detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', 'J5T-H-NEW').executeTakeFirstOrThrow();
    expect(detail).toMatchObject({ store: 'H', subOrderId: 'HP1', itemId: 'J5T-SKU', asin: 'J5T-SKU', name: 'Lamp', qty: 3, image: 'J5T-main.jpg' });
    expect(await db.selectFrom('os_grant_order').select('id').where('orderId', '=', 'J5T-H-EXISTS').execute()).toHaveLength(1);
  });
});
