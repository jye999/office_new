// U9 eBay actions: every Trading API call is intercepted; temp DB rows are cleaned up.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { setCacheBackendForTests } from '../src/lib/cache.js';
import { setEbayTransportForTests } from '../src/lib/ebay.js';

let adminId = 0;
const xml = (body: string) => `<?xml version="1.0"?><Response xmlns="urn:ebay:apis:eBLBaseComponents">${body}</Response>`;
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
const cleanup = async () => {
  await db.deleteFrom('os_trackings').where('orderId', '=', 'ZZU9ORDER').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', '=', 'ZZU9PIC').execute();
  await db.deleteFrom('os_grant_order').where('orderId', '=', 'ZZU9PIC').execute();
};

beforeAll(async () => {
  adminId = (await db.selectFrom('os_users').innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id').select('os_users.id')
    .where('os_roles.name', 'in', ['admin', 'user', 'remote']).executeTakeFirst())?.id ?? 0;
  await cleanup();
});
afterEach(() => {
  setEbayTransportForTests(null);
  setCacheBackendForTests(null);
  delete process.env.DRY_RUN;
});
afterAll(async () => { await cleanup(); await db.destroy(); });

describe('U9 eBay actions', () => {
  it('guards every route before it can call eBay', async () => {
    const app = buildApp(false);
    for (const path of ['/getEbayItem', '/getEbayOrder', '/getEbayTran', '/updateEbayOrder', '/EbayComplete', '/geteBayImage', '/getRayeBayImage', '/loadeBayOrderIntoDB', '/UpdateEbayPic', '/UpdateRayEbayPic']) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode, path).toBe(302);
    }
    await app.close();
  });

  it('preserves the print_r and image response quirks with a stubbed Trading API', async () => {
    setEbayTransportForTests(async (req) => {
      const verb = req.headers['X-EBAY-API-CALL-NAME'];
      if (verb === 'GetOrders') return xml('<Ack>Success</Ack><OrderArray><Order><OrderID>O9</OrderID></Order></OrderArray>');
      if (verb === 'GetSellingManagerSaleRecord') return xml('<Ack>Success</Ack><SellingManagerSoldOrder><TotalAmount>4.00</TotalAmount></SellingManagerSoldOrder>');
      if (req.body.includes('<ItemID>multi</ItemID>')) return xml('<Ack>Success</Ack><Item><PictureDetails><PictureURL>http://x/a$_1.jpg</PictureURL><PictureURL>http://x/b$_1.jpg</PictureURL></PictureDetails></Item>');
      if (req.body.includes('<ItemID>variant</ItemID>')) return xml('<Ack>Success</Ack><Item><Variations><Pictures><VariationSpecificPictureSet><VariationSpecificValue>Blue</VariationSpecificValue><PictureURL>http://x/blue$_1.jpg</PictureURL></VariationSpecificPictureSet></Pictures></Variations></Item>');
      return xml('<Ack>Success</Ack><Item><ItemID>item</ItemID></Item>');
    });
    const app = buildApp();
    const item = await app.inject({ method: 'GET', url: '/getEbayItem?id=1' });
    expect(item.statusCode).toBe(200);
    expect(item.body).toMatch(/^SimpleXMLElement Object\n\(\n    \[Ack\] => Success/);
    expect(item.body).toContain('261521059197_20_0_1/500x500.jpg');
    expect((await app.inject({ method: 'GET', url: '/getEbayOrder?id=O9' })).body).toBe('{"Ack":"Success","OrderArray":{"Order":{"OrderID":"O9"}}}');
    expect((await app.inject({ method: 'GET', url: '/getEbayTran?transId=T&itemId=I' })).body).toBe('{"Ack":"Success","SellingManagerSoldOrder":{"TotalAmount":"4.00"}}');
    expect((await app.inject({ method: 'GET', url: '/geteBayImage?itemId=multi' })).json()).toEqual(['http://x/a$_57.jpg', 'http://x/b$_57.jpg']);
    expect((await app.inject({ method: 'GET', url: '/getRayeBayImage?itemId=variant&value=Blue' })).body).toBe('http://x/blue$_57.jpg');
    await app.close();
  });

  it('keeps the literal %variant% image-update bug and the import cache throttle', async () => {
    const now = nowDb() as unknown as Date;
    await db.insertInto('os_grant_order').values({ store: 'E', orderId: 'ZZU9PIC', created_at: now, updated_at: now } as never).execute();
    await db.insertInto('os_grant_orderdetail').values({ store: 'E', orderId: 'ZZU9PIC', itemId: 'ZZU9PIC-LINE', asin: 'ITEM', variation: 'contains variant text', name: 'test', qty: 1, created_at: now, updated_at: now } as never).execute();
    const app = buildApp();
    expect((await post(app, '/UpdateEbayPic', { orderId: 'ZZU9PIC', itemId: 'ITEM', variant: 'different', url: 'new-url' })).statusCode).toBe(200);
    expect((await db.selectFrom('os_grant_orderdetail').select('image').where('orderId', '=', 'ZZU9PIC').executeTakeFirstOrThrow()).image).toBe('new-url');
    setCacheBackendForTests({
      get: async () => `s:19:"${new Date().toISOString().slice(0, 19).replace('T', ' ')}";`,
      setex: async () => 'OK',
    });
    expect((await app.inject({ method: 'GET', url: '/loadeBayOrderIntoDB' })).body).toBe('OK');
    await app.close();
  });

  it('writes the tracking record only after a stubbed CompleteSale success', async () => {
    setEbayTransportForTests(async () => xml('<Ack>Success</Ack>'));
    const app = buildApp();
    expect((await post(app, '/updateEbayOrder', { orderId: 'ZZU9ORDER', itemId: 'I', transId: 'T', tracking: 'Z1', url: 'u', stampsTxId: 's' })).json()).toBe('ok');
    expect(await db.selectFrom('os_trackings').select(['store', 'tracking', 'submissionStatus']).where('orderId', '=', 'ZZU9ORDER').executeTakeFirst()).toEqual({ store: 'E', tracking: 'Z1', submissionStatus: 'Complete' });
    await app.close();
  });
});
