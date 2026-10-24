// J4: Runner Walmart sync actions (get-walmart-items, update-walmart-inventory,
// upload-walmart-tracking). Nothing reaches walmart.com: the transport is mocked at
// setWalmartTransportForTests; DB tests use J4T-prefixed temp rows deleted in afterEach.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { actions, runSyncAction } from '../src/jobs/actions.js';
import { walmartItemsInsertSql, WALMART_ITEM_NAMES } from '../src/jobs/actions/walmart.js';
import { setWalmartTransportForTests, type WalmartRequest } from '../src/lib/walmart.js';

const actionNames = ['get-walmart-items', 'update-walmart-inventory', 'upload-walmart-tracking'];
// Commented out in Kernel.php and not invoked by any route/page: must stay the silent no-op.
const unported = ['walmart', 'walmart-dsv', 'get-walmart-dsv-items', 'update-walmart-dsv-inventory', 'upload-walmart-dsv-tracking'];

let sent: WalmartRequest[];
let replies: Record<string, string | Buffer>; // by "METHOD path-and-query" prefix, longest match wins

const tokenXml = (token = 'tok-1', expiresIn = 900) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:OAuthTokenDTO xmlns:ns2="http://walmart.com/"><accessToken>${token}</accessToken><tokenType>Bearer</tokenType><expiresIn>${expiresIn}</expiresIn></ns2:OAuthTokenDTO>`;
const listXml = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns3:list xmlns:ns2="http://walmart.com/" xmlns:ns3="http://walmart.com/mp/v3/orders">${inner}</ns3:list>`;
const orderEl = (po: string) => `<ns3:order><ns3:purchaseOrderId>${po}</ns3:purchaseOrderId></ns3:order>`;

beforeEach(() => {
  Object.assign(process.env, {
    WALMART_CLIENT_ID: 'cid',
    WALMART_CLIENT_SECRET: 'csecret',
    WALMART_CHANNEL_TYPE: 'chan-1',
  });
  delete process.env.DRY_RUN;
  sent = [];
  replies = { 'POST /v3/token': tokenXml() };
  setWalmartTransportForTests(async (req) => {
    sent.push(req);
    const u = new URL(req.url);
    const key = `${req.method} ${u.pathname}${u.search}`;
    const hit = Object.keys(replies).filter((k) => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return { status: 200, body: hit ? replies[hit] : '' };
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  setWalmartTransportForTests(null);
  delete process.env.DRY_RUN;
  delete process.env.STORAGE_DIR;
  vi.restoreAllMocks();
  // Temp rows the DB tests insert below.
  const productIds = (await db.selectFrom('os_products').select('id').where('sku', 'like', 'J4T%').execute()).map((r) => r.id);
  if (productIds.length > 0) await db.deleteFrom('os_product_locations').where('product_id', 'in', productIds).execute();
  await db.deleteFrom('os_products').where('sku', 'like', 'J4T%').execute();
  await db.deleteFrom('os_product_map').where('sku', 'like', 'J4T%').execute();
  await db.deleteFrom('os_walmart_items').where('sku', 'like', 'J4T%').execute();
  await db.deleteFrom('os_trackings').where('orderId', 'like', 'J4T%').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'J4T%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'J4T%').execute();
});

const arrayCombineForTest = (sku: string): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  WALMART_ITEM_NAMES.forEach((n, i) => (out[n] = i === 0 ? sku : i === 3 ? "it's\n" : `v${i}`));
  return out;
};

const insertOrder = (orderId: string, status: string | null) =>
  db.insertInto('os_grant_order').values({ store: 'W', orderId, status, created_at: nowDb() as never, updated_at: nowDb() as never }).execute();
const insertDetail = (orderId: string, itemId: string, extra: Record<string, unknown> = {}) =>
  db
    .insertInto('os_grant_orderdetail')
    .values({ store: 'W', orderId, itemId, name: 'Thing', qty: 1, ...extra, created_at: nowDb() as never, updated_at: nowDb() as never } as never)
    .execute();
const insertTracking = (orderId: string, tracking: string, createdAt: string = nowDb()) =>
  db.insertInto('os_trackings').values({ orderId, tracking, Url: '', created_at: createdAt as never, updated_at: nowDb() as never }).execute();

describe('J4 Walmart sync actions', () => {
  it('registers every J4 action and DRY_RUN makes no Walmart request or DB write', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (const action of actionNames) {
        expect(actions.has(action), action).toBe(true);
        await expect(runSyncAction(action)).resolves.toBe(0);
      }
      expect(info.mock.calls.filter(([message]) => String(message).includes('[DRY_RUN]')).length).toBe(3);
      expect(sent).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('the unported DSV/walmart actions stay the silent unknown-action no-op', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (const action of unported) {
        expect(actions.has(action), action).toBe(false);
        await expect(runSyncAction(action)).resolves.toBe(0);
      }
      expect(sent).toHaveLength(0);
      expect(info.mock.calls).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('get-walmart-items with an empty report: no truncate/insert, only the orderdetail backfill update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'j4-'));
    process.env.STORAGE_DIR = dir;
    replies['GET /v3/getReport'] = '<error/>'; // not a zip -> []
    const before = await db.selectFrom('os_walmart_items').select(db.fn.countAll().as('c')).executeTakeFirst();

    expect(await runSyncAction('get-walmart-items')).toBe(0);

    expect(sent.some((r) => r.url === 'https://marketplace.walmartapis.com/v3/getReport?type=item')).toBe(true);
    const after = await db.selectFrom('os_walmart_items').select(db.fn.countAll().as('c')).executeTakeFirst();
    expect(after!.c).toBe(before!.c); // not truncated
    await rm(dir, { recursive: true });
  });

  it('get-walmart-items non-empty report: insert has the 24 distinct columns, later duplicate category wins', () => {
    // Running this for real truncates the shared os_walmart_items table, so assert the SQL instead.
    const row = (sku: string) => arrayCombineForTest(sku);
    const sqlStr = walmartItemsInsertSql([row('J4T_RI1'), row('J4T_RI2')]);
    const cols = sqlStr.slice(sqlStr.indexOf('(') + 1, sqlStr.indexOf(')')).split(', ');
    expect(cols).toHaveLength(24);
    expect(new Set(cols).size).toBe(24);
    expect(sqlStr.startsWith('insert into os_walmart_items (sku, name, category, price, ')).toBe(true);
    expect(sqlStr).toContain("'J4T_RI1'");
    expect(sqlStr).toContain("'v16'"); // 17th field (second 'category') overwrote the 3rd
    expect(sqlStr).not.toContain("'v2'");
    expect(sqlStr).toContain("'it\\'s\\n'");
  });

  it('update-walmart-inventory: feed rows per WalmartItem with floor(count/qty), PO locations skipped, null quirks kept', async () => {
    const p1 = await db.insertInto('os_products').values({ sku: 'J4T_P1' }).executeTakeFirst();
    const p2 = await db.insertInto('os_products').values({ sku: 'J4T_P2' }).executeTakeFirst();
    const loc = (productId: number, location: string | null, qty: number | null, countdate: string | null) =>
      db.insertInto('os_product_locations').values({ product_id: productId, location, qty, countdate } as never).execute().then(() => undefined);
    // P1: 10 (old countdate) + 7 (null location, null countdate) + 5 (null countdate) = 22; 'PO BOX' and the -3 row excluded.
    const id1 = Number(p1.insertId);
    const id2 = Number(p2.insertId);
    await loc(id1, 'AI', 10, '2020-01-01 00:00:00');
    await loc(id1, 'PO BOX', 100, '2020-01-01 00:00:00');
    await loc(id1, null, 7, null);
    await loc(id1, 'FBA', 5, null);
    await loc(id1, 'AI', -3, '2020-01-01 00:00:00');
    // P2: mapped qty null -> skipped.
    await loc(id2, 'AI', 4, '2020-01-01 00:00:00');
    const map = (sku: string, externalId: string, qty: number | null) =>
      db.insertInto('os_product_map').values({ sku, store: 'W', externalId, qty }).execute();
    await map('J4T_P1', 'J4T_I1', 2);
    await map('J4T_P2', 'J4T_I2', null);
    await map('J4T_NP', 'J4T_I3', 1); // no os_products row -> skipped
    const item = (id: number, sku: string) => db.insertInto('os_walmart_items').values({ id, sku }).execute().then(() => undefined);
    await item(9900001, 'J4T_I1');
    await item(9900002, 'J4T_I2');
    await item(9900003, 'J4T_I3');
    await item(9900004, 'J4T_I4'); // no product_map row -> skipped

    expect(await runSyncAction('update-walmart-inventory')).toBe(0);

    const feed = sent.find((r) => r.method === 'POST' && r.url.startsWith('https://marketplace.walmartapis.com/v3/feeds?feedType=inventory'));
    expect(feed).toBeDefined();
    expect(feed!.body).toContain('<sku>J4T_I1</sku>\n            <availabilityCode>AC</availabilityCode>\n            <quantity>\n            <unit>EACH</unit>\n            <amount>11</amount>');
    for (const sku of ['J4T_I2', 'J4T_I3', 'J4T_I4']) expect(feed!.body).not.toContain(`<sku>${sku}</sku>`);
  });

  it('upload-walmart-tracking: ships W submit orders per detail, Done on success, stays on failure; acknowledged W orders with tracking go back to submit', async () => {
    await insertOrder('J4T_UP1', 'submit');
    await insertDetail('J4T_UP1', 'J4T_D1', { subOrderId: 'L1', qty: 2 });
    await insertTracking('J4T_UP1', '1Z004ABC', '2024-05-06 07:08:09');
    await insertOrder('J4T_UP2', 'submit');
    await insertDetail('J4T_UP2', 'J4T_D2', { subOrderId: 'L2', qty: 1 });
    await insertTracking('J4T_UP2', '999999999999');
    await insertOrder('J4T_ACK1', 'Ack');
    await insertTracking('J4T_ACK1', '9999999999999');

    replies['POST /v3/orders/J4T_UP1/shipping'] = '<ns2:orderShipmentResponse xmlns:ns2="http://walmart.com/"/>'; // no ns3:list -> success
    replies['POST /v3/orders/J4T_UP2/shipping'] = listXml(orderEl('J4T_UP2')); // an ns3:list -> failure
    replies['GET /v3/orders'] = listXml(`<ns3:meta><ns3:totalCount>1</ns3:totalCount></ns3:meta><ns3:elements>${orderEl('J4T_ACK1')}</ns3:elements>`);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let errMessages: string[];
    try {
      expect(await runSyncAction('upload-walmart-tracking')).toBe(0);
      errMessages = err.mock.calls.map(([m]) => String(m));
    } finally {
      err.mockRestore();
    }

    const ship1 = sent.find((r) => r.url === 'https://marketplace.walmartapis.com/v3/orders/J4T_UP1/shipping');
    expect(ship1?.body).toContain('<ns2:lineNumber>L1</ns2:lineNumber>');
    expect(ship1?.body).toContain('<ns2:amount>2</ns2:amount>');
    expect(ship1?.body).toContain('<ns2:carrier>USP</ns2:carrier>'); // '1Z...' prefix
    expect(ship1?.body).toContain('<ns2:trackingNumber>1Z004ABC</ns2:trackingNumber>');
    expect(ship1?.body).toContain('<ns2:shipDateTime>2024-05-06T07:08:09Z</ns2:shipDateTime>');
    expect(sent.some((r) => r.url === 'https://marketplace.walmartapis.com/v3/orders/J4T_UP2/shipping')).toBe(true);
    expect(errMessages.find((m) => m === 'failed to ship J4T_UP2')).toBeDefined();

    const status = async (orderId: string) =>
      (await db.selectFrom('os_grant_order').select('status').where('orderId', '=', orderId).executeTakeFirst())?.status;
    expect(await status('J4T_UP1')).toBe('Done');
    expect(await status('J4T_UP2')).toBe('submit'); // ship failed
    expect(await status('J4T_ACK1')).toBe('submit'); // acknowledged + has tracking

    const acknowledged = sent.find((r) => r.method === 'GET' && r.url.includes('status=Acknowledged'));
    expect(acknowledged?.url).toContain(`createdStartDate=${nowDb(new Date(Date.now() - 48 * 60 * 60 * 1000)).slice(0, 10)}`);
    expect(acknowledged?.url).toContain('limit=100&productInfo=true');
  });
});
