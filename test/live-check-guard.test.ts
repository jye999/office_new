// L13: scripts/liveCheckGuard.ts must refuse every write/purchase/upload/mail verb and allow only known reads.

import { describe, expect, it } from 'vitest';
import { assertReadOnlyHttp, assertReadOnlyOperation, guardFetch, ReadOnlyViolation, SOAP_READ_OPERATIONS, TRADING_READ_VERBS } from '../scripts/liveCheckGuard.js';
import { WRITE_VERBS } from '../src/lib/ebay.js';
import { WRITE_OPERATIONS as AMAZON_WRITES } from '../src/lib/amazonApi.js';
import { WRITE_OPERATIONS as FEDEX_WRITES } from '../src/lib/fedex.js';
import { WRITE_OPERATIONS as STAMPS_WRITES } from '../src/lib/stamps.js';
import { WRITE_OPERATIONS as FRAYUN_WRITES } from '../src/lib/frayun.js';
import { WRITE_ENDPOINTS } from '../src/lib/ups.js';

const refused = (method: string, url: string, headers: Record<string, string> = {}, body?: string) =>
  expect(() => assertReadOnlyHttp({ method, url, headers, body })).toThrow(ReadOnlyViolation);
const allowed = (method: string, url: string, headers: Record<string, string> = {}, body?: string) =>
  expect(() => assertReadOnlyHttp({ method, url, headers, body })).not.toThrow();

describe('live-check read-only guard', () => {
  it('refuses eBay write verbs and REST writes', () => {
    for (const verb of ['CompleteSale', 'ReviseItem', 'AddItem', 'EndItem', 'SendMessage']) {
      refused('POST', 'https://api.ebay.com/ws/api.dll', { 'X-EBAY-API-CALL-NAME': verb });
    }
    refused('POST', 'https://api.ebay.com/sell/fulfillment/v1/order/1/shipping_fulfillment');
    refused('DELETE', 'https://api.ebay.com/sell/inventory/v1/inventory_item/x');
    allowed('POST', 'https://api.ebay.com/ws/api.dll', { 'x-ebay-api-call-name': 'GetItem' });
    allowed('POST', 'https://api.ebay.com/identity/v1/oauth2/token');
    allowed('GET', 'https://api.ebay.com/sell/fulfillment/v1/order?limit=1');
  });

  it('refuses Amazon createShipment/createReport/feeds/patch and allows LWA, STS AssumeRole and GET', () => {
    refused('POST', 'https://sellingpartnerapi-na.amazon.com/mfn/v0/shipments');
    refused('POST', 'https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports');
    refused('POST', 'https://sellingpartnerapi-na.amazon.com/feeds/2021-06-30/feeds');
    refused('PATCH', 'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/S/SKU');
    refused('POST', 'https://sts.us-east-1.amazonaws.com/?Action=GetSessionToken', {}, '');
    allowed('POST', 'https://api.amazon.com/auth/o2/token');
    allowed('POST', 'https://sts.us-east-1.amazonaws.com/?Action=AssumeRole&RoleArn=x', {}, '');
    allowed('GET', 'https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports?pageSize=10');
  });

  it('refuses Walmart/Shopify/Etsy writes and allows GET (+ Walmart token)', () => {
    refused('POST', 'https://marketplace.walmartapis.com/v3/orders/1/acknowledge');
    refused('POST', 'https://marketplace.walmartapis.com/v3/orders/1/shipping');
    refused('POST', 'https://marketplace.walmartapis.com/v3/feeds?feedType=inventory');
    refused('POST', 'https://angel-isabella.myshopify.com/admin/orders/1/fulfillments.json');
    refused('PUT', 'https://angel-isabella.myshopify.com/admin/products/1.json');
    refused('DELETE', 'https://angel-isabella.myshopify.com/admin/products/1.json');
    refused('POST', 'https://openapi.etsy.com/v3/application/shops/__SELF__/receipts/1/tracking');
    allowed('POST', 'https://marketplace.walmartapis.com/v3/token');
    allowed('GET', 'https://marketplace.walmartapis.com/v3/orders?limit=1');
    allowed('GET', 'https://angel-isabella.myshopify.com/admin/shop.json');
    allowed('GET', 'https://openapi.etsy.com/v3/application/shops/__SELF__/sections');
  });

  it('refuses Houzz updateOrder and unknown methods; allows getOrders', () => {
    refused('GET', 'https://api.houzz.com/api?format=json&method=updateOrder&OrderId=1&Action=Ship');
    refused('GET', 'https://api.houzz.com/api?format=json&method=getShippingLabel&OrderId=1');
    allowed('GET', 'https://api.houzz.com/api?format=json&method=getOrders&Status=Active');
  });

  it('refuses UPS ShipConfirm/ShipAccept/Void, USPS non-read APIs, and unknown hosts / plain http', () => {
    for (const p of WRITE_ENDPOINTS) refused('POST', `https://onlinetools.ups.com/ups.app/xml${p}`);
    allowed('POST', 'https://onlinetools.ups.com/ups.app/xml/XAV');
    refused('GET', 'https://secure.shippingapis.com/ShippingAPI.dll?API=eVS&XML=x');
    allowed('GET', 'https://secure.shippingapis.com/ShippingAPI.dll?API=RateV4&XML=x');
    refused('GET', 'https://example.com/anything');
    refused('GET', 'http://api.ebay.com/sell/fulfillment/v1/order');
    refused('POST', 'https://smtp.example.com/send');
  });

  it('refuses every write op the clients themselves flag (none is in an allow-list)', () => {
    for (const verb of WRITE_VERBS) expect(TRADING_READ_VERBS.has(verb)).toBe(false);
    for (const _op of AMAZON_WRITES) refused('POST', 'https://sellingpartnerapi-na.amazon.com/x');
    expect(FEDEX_WRITES.size + STAMPS_WRITES.size + FRAYUN_WRITES.size).toBeGreaterThan(0);
    for (const op of FEDEX_WRITES) expect(() => assertReadOnlyOperation('fedex', op)).toThrow(ReadOnlyViolation);
    for (const op of STAMPS_WRITES) expect(() => assertReadOnlyOperation('stamps', op)).toThrow(ReadOnlyViolation);
    for (const op of FRAYUN_WRITES) expect(() => assertReadOnlyOperation('frayun', op)).toThrow(ReadOnlyViolation);
    for (const op of ['CreateIndicium', 'PurchasePostage', 'CreateScanForm', 'CancelIndicium']) {
      expect(SOAP_READ_OPERATIONS.stamps.has(op)).toBe(false);
    }
    for (const op of ['processShipment', 'deleteShipment']) expect(SOAP_READ_OPERATIONS.fedex.has(op)).toBe(false);
    expect(SOAP_READ_OPERATIONS.frayun.has('CreatePreToJson')).toBe(false);
    expect(() => assertReadOnlyOperation('stamps', 'GetAccountInfo')).not.toThrow();
  });

  it('guardFetch rejects a write before it reaches the underlying fetch', async () => {
    let reached = 0;
    const inner = (async () => { reached++; return new Response('{}', { status: 200 }); }) as typeof fetch;
    const lines: string[] = [];
    const guarded = guardFetch(inner, (l) => lines.push(l));
    await expect(guarded('https://api.ebay.com/ws/api.dll', { method: 'POST', headers: { 'X-EBAY-API-CALL-NAME': 'CompleteSale' }, body: '<x/>' })).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(reached).toBe(0);
    await guarded('https://angel-isabella.myshopify.com/admin/shop.json?secret=1', { headers: { Authorization: 'Basic abc' } });
    expect(reached).toBe(1);
    expect(lines).toEqual(['GET angel-isabella.myshopify.com/admin/shop.json -> 200']);
  });
});
