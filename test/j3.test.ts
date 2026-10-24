// J3: Runner eBay sync actions (upload-ebay-tracking, upload-ray-ebay-tracking,
// update-ebay-handling). Nothing reaches eBay: every call goes through the L05
// transport seams; DB tests use J3T-prefixed temp rows deleted in afterEach.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { actions, runSyncAction } from '../src/jobs/actions.js';
import { setEbayTransportForTests, type EbayRequest } from '../src/lib/ebay.js';
import { setEbayApiTransportForTests, type EbayApiRequest } from '../src/lib/ebayApi.js';

const actionNames = ['upload-ebay-tracking', 'upload-ray-ebay-tracking', 'update-ebay-handling'];

let ebayCalls: EbayRequest[];
let ebayReply: string;
let apiCalls: EbayApiRequest[];

beforeEach(() => {
  Object.assign(process.env, {
    EBAY_TOKEN: 'TOK', EBAY_COMPATLEVEL: '1193', EBAY_DEVID: 'dev', EBAY_APPID: 'app', EBAY_CERTID: 'cert', EBAY_SITEID: '0',
    EBAY_SERVERURL: 'https://api.ebay.com/ws/api.dll',
    RAYSTORE_TOKEN: 'RTOK', RAYSTORE_COMPATLEVEL: '999', RAYSTORE_DEVID: 'rdev', RAYSTORE_APPID: 'rapp', RAYSTORE_CERTID: 'rcert',
    RAYSTORE_SITEID: '3', RAYSTORE_SERVERURL: 'https://api.ebay.com/ws/api2.dll',
    EBAY_API_URL: 'https://api.ebay.com', EBAY_OAUTH_REFRESH_TOKEN: 'ref',
  });
  delete process.env.DRY_RUN;
  delete process.env.MAIL_ENABLED;
  ebayCalls = [];
  ebayReply = `<?xml version="1.0"?><CompleteSaleResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack></CompleteSaleResponse>`;
  apiCalls = [];
  setEbayTransportForTests(async (req) => {
    ebayCalls.push(req);
    return ebayReply;
  });
  setEbayApiTransportForTests(async (req) => {
    apiCalls.push(req);
    if (req.url.endsWith('/identity/v1/oauth2/token')) return JSON.stringify({ access_token: 't', expires_in: 3600 });
    return JSON.stringify({ success: true });
  });
});

afterEach(async () => {
  delete process.env.DRY_RUN;
  delete process.env.MAIL_ENABLED;
  setEbayTransportForTests(null);
  setEbayApiTransportForTests(null);
  // Temp rows the DB tests insert below.
  await db.deleteFrom('os_trackings').where('orderId', 'like', 'J3T%').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'J3T%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'J3T%').execute();
});

const insertOrder = (orderId: string, store: string, status: string | null) =>
  db.insertInto('os_grant_order').values({ store, orderId, status, created_at: nowDb() as never, updated_at: nowDb() as never }).execute();

const insertDetail = (orderId: string, itemId: string, extra: Record<string, unknown> = {}) =>
  db
    .insertInto('os_grant_orderdetail')
    .values({ store: 'E', orderId, itemId, name: 'Thing', qty: 1, ...extra, created_at: nowDb() as never, updated_at: nowDb() as never } as never)
    .execute();

const insertTracking = (orderId: string, tracking: string) =>
  db.insertInto('os_trackings').values({ orderId, tracking, Url: '', created_at: nowDb() as never, updated_at: nowDb() as never }).execute();

describe('J3 eBay sync actions', () => {
  it('registers every J3 action and DRY_RUN makes no eBay request or DB write', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (const action of actionNames) {
        expect(actions.has(action), action).toBe(true);
        await expect(runSyncAction(action)).resolves.toBe(0);
      }
      expect(info.mock.calls.filter(([message]) => String(message).includes('[DRY_RUN]')).length).toBe(3);
      expect(ebayCalls).toHaveLength(0);
      expect(apiCalls).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('upload-ebay-tracking: UploadShipping with all items and the last non-null tracking, then Done', async () => {
    await insertOrder('J3T_E1', 'E', 'submit');
    await insertDetail('J3T_E1', 'D1', { subOrderId: 'LI1', qty: 2 });
    await insertDetail('J3T_E1', 'D2', { subOrderId: 'LI2', qty: 1 });
    await insertTracking('J3T_E1', '999999999999'); // 12 chars: not > 12 -> FedEx
    await insertTracking('J3T_E1', ''); // PHP loose != null: skipped
    // Empty tracking does not reset the earlier one (last non-null wins).
    await insertOrder('J3T_E2', 'E', 'submit');
    await insertDetail('J3T_E2', 'D3', { subOrderId: 'LI3', qty: 1 });
    await insertTracking('J3T_E2', '');

    expect(await runSyncAction('upload-ebay-tracking')).toBe(0);

    const posts = apiCalls.filter((req) => req.url.endsWith('/shipping_fulfillment'));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://api.ebay.com/sell/fulfillment/v1/order/J3T_E1/shipping_fulfillment');
    expect(posts[0].body).toContain('"lineItems": [{"lineItemId":"LI1","quantity":2},{"lineItemId":"LI2","quantity":1}]');
    expect(posts[0].body).toContain('"shippingCarrierCode": "FedEx"');
    expect(posts[0].body).toContain('"trackingNumber": "999999999999"');
    expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'J3T_E1').executeTakeFirst())?.status).toBe('Done');
    // J3T_E2 had no usable tracking: not uploaded, not marked Done.
    expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'J3T_E2').executeTakeFirst())?.status).toBe('submit');
  });

  it('upload-ray-ebay-tracking: CompleteSale per (detail, tracking), Done on Success, mail on failure', async () => {
    await insertOrder('J3T_R1', 'R', 'submit');
    await insertDetail('J3T_R1', '111-222', { store: 'R' });
    await insertDetail('J3T_R1', '333', { store: 'R' }); // no dash: legacy explode -> [1] null
    await insertTracking('J3T_R1', '9999999999999'); // 13 chars -> USPS
    // Failure order: exercises the messages + emailErrorMessage branch.
    await insertOrder('J3T_R2', 'R', 'submit');
    await insertDetail('J3T_R2', '444-555', { store: 'R' });
    await insertTracking('J3T_R2', '9999999999999');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // The stub answers Success; the Failure case is exercised by re-running just the failure order below.
      expect(await runSyncAction('upload-ray-ebay-tracking')).toBe(0);
      const completeSales = ebayCalls.filter((req) => req.body.includes('<CompleteSaleRequest'));
      expect(completeSales).toHaveLength(3); // (111-222, 333) + (444-555), one per detail x tracking
      expect(completeSales[0].url).toBe('https://api.ebay.com/ws/api2.dll');
      expect(completeSales[0].body).toContain('<ItemID>111</ItemID>');
      expect(completeSales[0].body).toContain('<TransactionID>222</TransactionID>');
      expect(completeSales[0].body).toContain('<ShippingCarrierUsed>USPS</ShippingCarrierUsed>');
      expect(completeSales[1].body).toContain('<ItemID>333</ItemID><Shipment>');
      expect(completeSales[1].body).toContain('<TransactionID></TransactionID>');
      expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'J3T_R1').executeTakeFirst())?.status).toBe('Done');
      expect(log.mock.calls.filter(([m]) => String(m).includes('Tracking Upload Error!')).length).toBe(0);
    } finally {
      log.mockRestore();
    }

    ebayReply = `<?xml version="1.0"?><CompleteSaleResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Failure</Ack></CompleteSaleResponse>`;
    // Reset both orders (the Success pass marked them Done) so the Failure path reruns.
    await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: nowDb() as never }).where('orderId', 'in', ['J3T_R1', 'J3T_R2']).execute();
    ebayCalls = [];
    const log2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSyncAction('upload-ray-ebay-tracking')).toBe(0);
      const completeSales = ebayCalls.filter((req) => req.body.includes('<CompleteSaleRequest'));
      expect(completeSales).toHaveLength(3);
      const mail = log2.mock.calls.map(([m]) => String(m)).find((m) => m.includes('Tracking Upload Error!'));
      expect(mail).toBeDefined();
      // MAIL_ENABLED unset: logged, not sent.
      expect(log2.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('[mail disabled]'))).toContain('to=mr.johnny.ye@gmail.com');
      expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'J3T_R1').executeTakeFirst())?.status).toBe('submit');
      expect((await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'J3T_R2').executeTakeFirst())?.status).toBe('submit');
    } finally {
      log2.mockRestore();
    }
  });

  it('update-ebay-handling: fills null and 0 handling from DispatchTimeMax, leaves others alone', async () => {
    await insertOrder('J3T_H1', 'E', null);
    await insertDetail('J3T_H1', 'H1', { asin: 'J3T_ASIN', handling: null });
    await insertDetail('J3T_H1', 'H2', { asin: 'J3T_ASIN', handling: 0 }); // PHP loose == null: 0 counts as null
    await insertDetail('J3T_H1', 'H3', { asin: 'J3T_ASIN', handling: 1 });
    // A status!=null order is not considered.
    await insertOrder('J3T_H2', 'E', 'submit');
    await insertDetail('J3T_H2', 'H4', { asin: 'J3T_ASIN', handling: null });

    ebayReply = `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><ItemID>1</ItemID><DispatchTimeMax>3</DispatchTimeMax></Item></GetItemResponse>`;

    expect(await runSyncAction('update-ebay-handling')).toBe(0);

    const gets = ebayCalls.filter((req) => req.body.includes('<GetItemRequest'));
    expect(gets).toHaveLength(2); // only H1 and H2's details; H3 (handling 1) is skipped, J3T_H2 excluded
    expect(gets[0].body).toContain('<ItemID>J3T_ASIN</ItemID><DetailLevel>ReturnAll</DetailLevel>');
    const rows = await db.selectFrom('os_grant_orderdetail').select(['itemId', 'handling']).where('orderId', '=', 'J3T_H1').execute();
    const byId = Object.fromEntries(rows.map((r) => [r.itemId, String(r.handling ?? '')]));
    expect(byId.H1).toBe('3');
    expect(byId.H2).toBe('3');
    expect(byId.H3).toBe('1');
  });
});
