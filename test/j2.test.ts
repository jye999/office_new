import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { actions, runSyncAction } from '../src/jobs/actions.js';
import { fbaInventoryRows, getAmzOrderReport, storeAmazonOrders } from '../src/jobs/actions/amazon.js';
import { setAmazonTransportForTests, type AmazonRequest, type AmazonResponse } from '../src/lib/amazonApi.js';
import { setU10FetchForTests } from '../src/modules/unshipped/service.js';

const actionNames = [
  'amazon', 'request-amazon-orders-report', 'get-amazon-orders-report', 'update-amz-shipped', 'get-amz-image-by-asin',
  'request-fba-inventory-report', 'get-fba-inventory-report', 'request-merchant-listing-report', 'get-merchant-listing-report',
  'request-fba-health-report', 'get-fba-health-report', 'request-fba-age-report', 'get-fba-age-report',
];

const amzStub = (tsvReport: { reportId: string; docId: string; reportType: string; url: string }) =>
  async (req: AmazonRequest): Promise<AmazonResponse> => {
    const url = new URL(req.url);
    const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
    if (url.host === 'api.amazon.com') return json({ access_token: 'token', expires_in: 3600 });
    if (url.host.startsWith('sts.')) return json({ AssumeRoleResponse: { AssumeRoleResult: { Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: Math.floor(Date.now() / 1000) + 3600 } } } });
    if (url.pathname.includes('/restrictedDataToken')) return json({ restrictedDataToken: 'rdt' });
    if (req.method === 'POST' && url.pathname.endsWith('/reports')) return json({ reportId: tsvReport.reportId, createdTime: '2025-01-01T12:00:00.000Z' });
    if (url.pathname.endsWith('/reports')) return json({ reports: [{ reportId: tsvReport.reportId, reportDocumentId: tsvReport.docId, reportType: tsvReport.reportType, createdTime: '2025-01-01T12:00:00.000Z', completedTime: '2025-01-01T12:05:00.000Z' }] });
    if (url.pathname.includes('/documents/')) return json({ reportDocumentId: tsvReport.docId, url: tsvReport.url });
    if (url.pathname.includes('/listings/')) return json({ sku: 'J2T_SKU', attributes: {} });
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  };

afterEach(async () => {
  delete process.env.DRY_RUN;
  setAmazonTransportForTests(null);
  setU10FetchForTests(null);
  // Temp rows the DB tests insert below.
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'J2T%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'J2T%').execute();
  await db.deleteFrom('os_grant_inventory').where('sku', 'like', 'J2T%').execute();
  await db.deleteFrom('os_AMZ_ORDERS').where('amazon-order-id', 'like', 'J2T%').execute();
  await db.deleteFrom('os_AMZ_ORDERS').where('amazon-order-id', '=', 'J2T_AMZ').execute();
});

describe('J2 Amazon sync actions', () => {
  it('registers every J2 action and DRY_RUN makes no Amazon request or DB write', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (const action of actionNames) {
        expect(actions.has(action), action).toBe(true);
        await expect(runSyncAction(action, 'B0J2TEST')).resolves.toBe(0);
      }
      expect(info.mock.calls.filter(([message]) => String(message).includes('[DRY_RUN]')).length).toBe(10);
    } finally {
      info.mockRestore();
    }
  });

  it('maps the legacy FBA inventory header names', () => {
    expect(fbaInventoryRows([
      { 'seller-sku': 'SKU', 'fulfillment-channel-sku': 'FNSKU', asin: 'ASIN', 'condition-type': 'New', 'Warehouse-Condition-code': 'SELLABLE', 'Quantity Available': '3' },
    ])).toEqual([{ sku: 'SKU', afnsku: 'FNSKU', asin: 'ASIN', conditionType: 'New', warehouseCondition: 'SELLABLE', qty: '3' }]);
  });

  it('getAmz: one grant_order per report order, backfills empty asin/image, marks missing orders done', async () => {
    const now = nowDb() as unknown as Date;
    await db.insertInto('os_grant_order').values({ store: 'A', orderId: 'J2T_OLD', status: null, created_at: now, updated_at: now } as never).execute();
    await db.insertInto('os_grant_inventory').values({ site: 'A', sku: 'J2T_SKU', asin: 'J2T_ASIN', image: 'https://img.example/x.jpg', qty: 1, created_at: now, updated_at: now } as never).execute();
    // Existing detail for J2T_NEW/I1 with empty asin/image: exercises the legacy backfill branch.
    await db.insertInto('os_grant_orderdetail').values({ store: 'A', orderId: 'J2T_NEW', itemId: 'I1', name: 'Thing', qty: 1, asin: '', image: '', created_at: now, updated_at: now } as never).execute();

    const tsv = [
      'order-id\torder-item-id\tproduct-name\tquantity-purchased\tsku\tpurchase-date\tpayments-date\trecipient-name\tbuyer-email\tbuyer-phone-number\tship-address-1\tship-address-2\tship-address-3\tship-city\tship-state\tship-postal-code\tship-country\tship-service-level\tis-prime\tpromise-date\tis-buyer-requested-cancellation\tis-replacement-order',
      'J2T_NEW\tI1\tThing\t1\tJ2T_SKU\t2025-01-01T10:00:00-07:00\t2025-01-01T10:00:00-07:00\tBuyer\tb@x.com\t555\t1 St\t\t\tCity\tGA\t30041\tUS\tStd\tfalse\t2025-01-03T10:00:00-07:00\tfalse\tfalse',
      'J2T_NEW\tI2\tThing2\t2\tJ2T_SKU\t2025-01-01T10:00:00-07:00\t2025-01-01T10:00:00-07:00\tBuyer\tb@x.com\t555\t1 St\t\t\tCity\tGA\t30041\tUS\tStd\tfalse\t2025-01-03T10:00:00-07:00\tfalse\tfalse',
    ].join('\n');
    setAmazonTransportForTests(amzStub({ reportId: 'J2T_RPT', docId: 'J2T_DOC', reportType: 'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING', url: 'http://report.example/file.tsv' }));
    setU10FetchForTests(async () => tsv);

    expect(await runSyncAction('amazon')).toBe(0);

    // Two report items of the same order create exactly one grant_order (legacy in_array dedupe).
    const orders = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', 'J2T_NEW').execute();
    expect(orders.length).toBe(1);
    const backfilled = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', 'J2T_NEW').where('itemId', '=', 'I1').executeTakeFirst();
    expect(backfilled?.asin).toBe('J2T_ASIN');
    expect(backfilled?.image).toBe('//img.example/x.jpg');
    const details = await db.selectFrom('os_grant_orderdetail').select('id').where('orderId', '=', 'J2T_NEW').execute();
    expect(details.length).toBe(2);
    const old = await db.selectFrom('os_grant_order').select('status').where('orderId', '=', 'J2T_OLD').executeTakeFirst();
    expect(old?.status).toBe('Done');
  });

  it('storeAmazonOrders: inserts new rows, updates changed status, joins the raw price formula', async () => {
    const now = nowDb() as unknown as Date;
    await db.insertInto('os_grant_orderdetail').values({ store: 'A', orderId: 'J2T_AMZ', itemId: 'J2T_ITEM', name: 'Thing', qty: 1, price: null, created_at: now, updated_at: now } as never).execute();
    await storeAmazonOrders([
      {
        'amazon-order-id': 'J2T_AMZ', 'product-name': 'Thing', sku: 'J2T_SKU', quantity: '1',
        'item-price': '10', 'item-tax': '1', 'shipping-price': '2', 'shipping-tax': '0', 'gift-wrap-price': '0', 'gift-wrap-tax': '0',
        'item-promotion-discount': '0', 'ship-promotion-discount': '0', 'order-status': 'Pending', 'item-status': 'Unshipped',
        'last-updated-date': '2025-01-01T10:00:00-07:00', 'purchase-date': '2025-01-01T10:00:00-07:00', currency: 'USD',
      },
    ]);
    const inserted = await db.selectFrom('os_AMZ_ORDERS').selectAll().where('amazon-order-id', '=', 'J2T_AMZ').executeTakeFirst();
    expect(inserted).not.toBeNull();
    // 10 + 1 + 2 + 0 + 0 + 0 - 0 - 0
    const detail = await db.selectFrom('os_grant_orderdetail').select('price').where('orderId', '=', 'J2T_AMZ').executeTakeFirst();
    expect(String(detail?.price ?? '')).toBe('13');
    // Second pass with a changed order-status updates the existing row, no duplicate.
    await storeAmazonOrders([
      {
        'amazon-order-id': 'J2T_AMZ', 'product-name': 'Thing', sku: 'J2T_SKU', quantity: '1',
        'item-price': '10', 'item-tax': '1', 'shipping-price': '2', 'shipping-tax': '0', 'gift-wrap-price': '0', 'gift-wrap-tax': '0',
        'item-promotion-discount': '0', 'ship-promotion-discount': '0', 'order-status': 'Shipped', 'item-status': 'Shipped',
        'last-updated-date': '2025-01-02T10:00:00-07:00', 'purchase-date': '2025-01-01T10:00:00-07:00', currency: 'USD',
      },
    ]);
    const rows = await db.selectFrom('os_AMZ_ORDERS').select('id').where('amazon-order-id', '=', 'J2T_AMZ').execute();
    expect(rows.length).toBe(1);
    const updated = await db.selectFrom('os_AMZ_ORDERS').select('order-status').where('amazon-order-id', '=', 'J2T_AMZ').executeTakeFirst();
    expect(updated?.['order-status']).toBe('Shipped');
  });

  it('getAmzOrderReport parses 18 columns without the header-length check', async () => {
    setAmazonTransportForTests(amzStub({ reportId: 'J2T_R2', docId: 'J2T_DOC2', reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL', url: 'http://report.example/order.tsv' }));
    const header = Array.from({ length: 20 }, (_, i) => `col${i}`).join('\t');
    setU10FetchForTests(async () => [header, '1\t2\t3\t4\t5\t6\t7\t8\t9\t10\t11\t12\t13\t14\t15\t16\t17\t18\t19\t20', 'short'].join('\n'));
    const rows = await getAmzOrderReport();
    // The 20-field row is sliced to 18 (no header-length check); 'short' has only 1 field.
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).length).toBe(18);
  });
});
