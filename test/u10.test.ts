// U10 marketplace descriptions/actions. Every remote transport is stubbed and
// temporary DB fixtures use ZZU10* ids and are deleted in afterAll.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { setAmazonTransportForTests } from '../src/lib/amazonApi.js';
import { setEbayApiTransportForTests } from '../src/lib/ebayApi.js';
import { setEtsyTransportForTests } from '../src/lib/etsy.js';
import { setHouzzTransportForTests } from '../src/lib/houzz.js';
import { setShopifyTransportForTests } from '../src/lib/shopify.js';
import { setCacheBackendForTests } from '../src/lib/cache.js';
import { setU10FetchForTests } from '../src/modules/unshipped/service.js';

let adminId = 0;
function buildApp(withUser = true) {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerUnshippedRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (withUser) (req.session as Record<string, unknown>)['user_id'] = adminId;
  });
  return app;
}
const post = (app: ReturnType<typeof buildApp>, url: string, p: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload: new URLSearchParams(p).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
async function cleanup() {
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'ZZU10%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'ZZU10%').execute();
  await db.deleteFrom('os_grant_inventory').where('sku', 'like', 'ZZU10%').execute();
}
function stubAmazonReports() {
  Object.assign(process.env, { AMZ_LWA_CLIENT_ID: 'c', AMZ_LWA_CLIENT_SECRET: 's', AMZ_LWA_REFRESH_TOKEN: 'r', AMZ_ACCESS_KEY_ID: 'k', AMZ_ACCESS_SECRET: 'x' });
  setAmazonTransportForTests(async (req) => {
    const url = new URL(req.url);
    if (url.host === 'api.amazon.com') return { status: 200, body: JSON.stringify({ access_token: 'token', expires_in: 3600 }) };
    if (url.host.startsWith('sts.')) return { status: 200, body: JSON.stringify({ AssumeRoleResponse: { AssumeRoleResult: { Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: Math.floor(Date.now() / 1000) + 3600 } } } }) };
    if (req.method === 'POST' && url.pathname.endsWith('/reports')) return { status: 200, body: JSON.stringify({ reportId: 'request' }) };
    if (url.pathname.endsWith('/reports')) return { status: 200, body: JSON.stringify({ reports: [{ reportDocumentId: 'document' }] }) };
    if (url.pathname.includes('/documents/')) return { status: 200, body: JSON.stringify({ reportDocumentId: 'document', url: 'https://report.test/data' }) };
    if (url.pathname.includes('/listings/')) return { status: 200, body: JSON.stringify({ summaries: [{ productType: 'TYPE', itemName: 'David Georgia' }], attributes: { product_description: [{ value: 'Tiffany IN USA' }], bullet_point: [{ value: "David's Bridal" }] } }) };
    return { status: 200, body: JSON.stringify({ reportId: 'request' }) };
  });
}

beforeAll(async () => {
  adminId = (await db.selectFrom('os_users').innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id').select('os_users.id')
    .where('os_roles.name', 'in', ['admin', 'user', 'remote']).executeTakeFirst())?.id ?? 0;
  await cleanup();
  const now = nowDb() as unknown as Date;
  await db.insertInto('os_grant_inventory').values({ site: 'A', sku: 'ZZU10SKU', asin: 'ZZU10ASIN', qty: 4, created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_grant_order').values({ store: 'S', orderId: 'ZZU10SHOP', created_at: now, updated_at: now } as never).execute();
  await db.insertInto('os_grant_orderdetail').values({ store: 'S', orderId: 'ZZU10SHOP', subOrderId: '123-456', itemId: 'line', name: 'n', qty: 1, created_at: now, updated_at: now } as never).execute();
});
afterEach(() => {
  setAmazonTransportForTests(null);
  setEbayApiTransportForTests(null);
  setEtsyTransportForTests(null);
  setHouzzTransportForTests(null);
  setShopifyTransportForTests(null);
  setCacheBackendForTests(null);
  setU10FetchForTests(null);
  delete process.env.DRY_RUN;
});
afterAll(async () => { await cleanup(); await db.destroy(); });

describe('U10 route guards', () => {
  it('requires an allowed role for every U10 route', async () => {
    const app = buildApp(false);
    for (const path of ['/ShopifyDesc', '/FulfillShopify', '/getAmzImage', '/downloadAmzImage', '/loadAmzOrderIntoDB', '/RequestAmzOrderReport', '/GetAmzOrderReport', '/Test', '/TestAmzApi', '/ebayDesc', '/storeDesc', '/etsyDesc', '/etsyListing', '/Houzz.ajax']) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode, path).toBe(302);
    }
    await app.close();
  });
});

describe('U10 handlers with stubs', () => {
  it('returns inventory JSON and renders the legacy Test page', async () => {
    await db.deleteFrom('os_grant_inventory').where('sku', '=', 'ZZU10SKU').execute();
    await db.insertInto('os_grant_inventory').values({ site: 'A', sku: 'ZZU10SKU', asin: 'ZZU10ASIN', qty: 4, created_at: nowDb(), updated_at: nowDb() } as never).execute();
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/getAmzImage?asin=ZZU10ASIN' })).json()).toMatchObject({ sku: 'ZZU10SKU', qty: 4 });
    expect((await app.inject({ method: 'GET', url: '/getAmzImage?asin=missing' })).json()).toBe('');
    const test = await app.inject({ method: 'GET', url: '/Test' });
    expect(test.body).toContain('mergeAllPDFs(["/assets/js/1.pdf","/assets/js/1.pdf"]');
    await app.close();
  });

  it('renders Shopify and Etsy listing descriptions and fulfills only through its stub', async () => {
    const calls: string[] = [];
    setShopifyTransportForTests(async (req) => {
      calls.push(req.method);
      return { status: 200, reason: 'OK', headers: {}, body: req.method === 'GET' ? JSON.stringify({ product: { title: 'Title', body_html: '<b>Body</b>', images: [{ src: 'https://img' }] } }) : JSON.stringify({ fulfillment: { id: 1 } }) };
    });
    setEtsyTransportForTests(async () => ({ status: 200, reason: 'OK', body: JSON.stringify({ description: 'Etsy desc', images: [{ url_570xN: 'https://etsy.img' }] }) }));
    const app = buildApp();
    const shopify = await app.inject({ method: 'GET', url: '/ShopifyDesc?product=1' });
    expect(shopify.body).toContain('<h3>Title</h3>');
    expect(shopify.body).toContain('<b>Body</b>');
    const listing = await app.inject({ method: 'GET', url: '/etsyListing?Id=3' });
    expect(listing.body).toContain('<pre>Etsy desc</pre><br/><img');
    expect((await post(app, '/FulfillShopify', { orderId: 'ZZU10SHOP', tracking: 'T1', trackingCompany: 'UPS' })).json()).toEqual({ id: 1 });
    expect(calls).toEqual(['GET', 'POST']);
    expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'ZZU10SHOP').executeTakeFirstOrThrow()).status).toBe('Done');
    await app.close();
  });

  it('uses report/document stubs for Amazon reports and blocks TestAmzApi before its listing patch', async () => {
    stubAmazonReports();
    setU10FetchForTests(async (url) => url === 'https://report.test/data' ? 'order-status\tamazon-order-id\nShipped\tZZU10ORDER\n' : '<html></html>');
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/GetAmzOrderReport' })).json()).toEqual([{ 'order-status': 'Shipped', 'amazon-order-id': 'ZZU10ORDER' }]);
    expect((await app.inject({ method: 'GET', url: '/RequestAmzOrderReport' })).body).toContain('[report_id] => request');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect((await app.inject({ method: 'GET', url: '/TestAmzApi' })).statusCode).toBe(500);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[DRY_RUN] Amazon SP-API patchListingsItem not sent'), expect.any(String));
    info.mockRestore();
    await app.close();
  });

  it('preserves description HTML and raw-string Houzz JSON quirks through stubs', async () => {
    setEbayApiTransportForTests(async (req) => req.url.includes('/identity/') ? JSON.stringify({ access_token: 'token' }) : JSON.stringify({ description: '<i>eBay</i>' }));
    setEtsyTransportForTests(async () => ({ status: 200, reason: 'OK', body: JSON.stringify({ results: [] }) }));
    setHouzzTransportForTests(async () => '{"orders":[1]}');
    setU10FetchForTests(async (url) => url.includes('angelisabella') ? JSON.stringify({ products: [{ description: '&lt;b&gt;Store&lt;/b&gt;', images: [{ image: 'x.jpg' }] }] }) : 'colorImages colorImages = { \'initial\': [{"main":{"a":"b"}}]} colorToAsin');
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/ebayDesc?itemId=1|2' })).body).toBe('<html><meta http-equiv="Content-Type" content="text/html;charset=utf-8" /><body><i>eBay</i></body></html>');
    expect((await app.inject({ method: 'GET', url: '/storeDesc?pId=1' })).body).toContain("<body><b>Store</b><img src='//www.angelisabella.com/image/x.jpg' style='width:800px;' /></body>");
    expect((await app.inject({ method: 'GET', url: '/etsyDesc?tId=1' })).body).toBe('');
    expect((await app.inject({ method: 'GET', url: '/Houzz.ajax' })).body).toBe('"{\\"orders\\":[1]}"');
    const pics = await app.inject({ method: 'GET', url: '/downloadAmzImage?asin=x' });
    expect(pics.body).toContain('a<hr>');
    await app.close();
  });

  it('takes loadAmzOrderIntoDB cache throttle without touching Amazon', async () => {
    setCacheBackendForTests({ get: async () => `s:19:"${new Date().toISOString().slice(0, 19).replace('T', ' ')}";`, setex: async () => 'OK' });
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/loadAmzOrderIntoDB' })).body).toBe('OK');
    await app.close();
  });
});
