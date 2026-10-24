// L05: App\Libraries\eBay (Trading API XML) + eBayApi (REST/OAuth) ports. Nothing reaches eBay: every call
// goes through setEbayTransportForTests / setEbayApiTransportForTests and the assertions compare against
// what the PHP would send (bodies written out from eBay.php / eBayApi.php).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ebay, EbayError, ebayGetMyMessages, setEbayTransportForTests, xmlList, xmlText, type EbayRequest } from '../src/lib/ebay.js';
import { EbayApi, EbayApiError, setEbayApiTransportForTests, type EbayApiRequest } from '../src/lib/ebayApi.js';

const HEAD = '<?xml version="1.0" encoding="utf-8" ?>';
const NS = 'xmlns="urn:ebay:apis:eBLBaseComponents"';
const CREDS = '<RequesterCredentials><eBayAuthToken>TOK</eBayAuthToken></RequesterCredentials>';
const VERSION = '<Version>1193</Version>';

let calls: EbayRequest[];
let reply: string;

beforeEach(() => {
  Object.assign(process.env, {
    EBAY_TOKEN: 'TOK', EBAY_COMPATLEVEL: '1193', EBAY_DEVID: 'dev', EBAY_APPID: 'app', EBAY_CERTID: 'cert', EBAY_SITEID: '0',
    EBAY_SERVERURL: 'https://api.ebay.com/ws/api.dll',
    RAYSTORE_TOKEN: 'RTOK', RAYSTORE_COMPATLEVEL: '999', RAYSTORE_DEVID: 'rdev', RAYSTORE_APPID: 'rapp', RAYSTORE_CERTID: 'rcert',
    RAYSTORE_SITEID: '3', RAYSTORE_SERVERURL: 'https://api.ebay.com/ws/api2.dll',
  });
  delete process.env.DRY_RUN;
  calls = [];
  reply = `<?xml version="1.0"?><XResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack></XResponse>`;
  setEbayTransportForTests(async (req) => {
    calls.push(req);
    return reply;
  });
});
afterEach(() => {
  setEbayTransportForTests(null);
  vi.useRealTimers();
});

describe('Ebay (Trading API)', () => {
  it('sends the eBay headers and returns the parsed reply (SimpleXML-as-json shape)', async () => {
    reply = `<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><ItemID>9</ItemID>` +
      `<Price currencyID="USD">12.5</Price><V>1</V><V>2</V></Item></GetItemResponse>`;
    const r = await new Ebay().getItem(123);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.ebay.com/ws/api.dll');
    expect(calls[0].headers).toEqual({
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-DEV-NAME': 'dev',
      'X-EBAY-API-APP-NAME': 'app',
      'X-EBAY-API-CERT-NAME': 'cert',
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'X-EBAY-API-SITEID': '0',
    });
    expect(calls[0].body).toBe(`${HEAD}<GetItemRequest ${NS}>${CREDS}<ItemID>123</ItemID><DetailLevel>ReturnAll</DetailLevel>${VERSION}</GetItemRequest>`);
    expect(r.Ack).toBe('Success');
    expect(xmlText(r.Item.ItemID)).toBe('9');
    expect(xmlText(r.Item.Price)).toBe('12.5');
    expect(xmlList(r.Item.V)).toEqual(['1', '2']);
    expect(xmlList(r.Item.Nope)).toEqual([]);
  });

  it('awaitingShipment2 / getActiveListing bodies', async () => {
    const e = new Ebay();
    await e.awaitingShipment2(3);
    await e.getActiveListing(2);
    expect(calls[0].headers['X-EBAY-API-CALL-NAME']).toBe('GetSellingManagerSoldListings');
    expect(calls[0].body).toBe(
      `${HEAD}<GetSellingManagerSoldListingsRequest ${NS}>${CREDS}<Filter>PaidNotShipped</Filter><Sort>SaleDate</Sort>` +
        `<SortOrder>Descending</SortOrder><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>3</PageNumber></Pagination>` +
        `${VERSION}</GetSellingManagerSoldListingsRequest>`,
    );
    expect(calls[1].headers['X-EBAY-API-CALL-NAME']).toBe('GetMyeBaySelling');
    expect(calls[1].body).toBe(
      `${HEAD}<GetMyeBaySellingRequest ${NS}>${CREDS}<ActiveList><Include>true</Include><Sort>TimeLeft</Sort>` +
        `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>2</PageNumber></Pagination></ActiveList>${VERSION}</GetMyeBaySellingRequest>`,
    );
  });

  it('getSaleRecordDetail(transactionId, itemId) sends ItemID before TransactionID', async () => {
    await new Ebay().getSaleRecordDetail('T1', 'I1');
    expect(calls[0].headers['X-EBAY-API-CALL-NAME']).toBe('GetSellingManagerSaleRecord');
    expect(calls[0].body).toBe(
      `${HEAD}<GetSellingManagerSaleRecordRequest ${NS}>${CREDS}<ItemID>I1</ItemID><TransactionID>T1</TransactionID>${VERSION}</GetSellingManagerSaleRecordRequest>`,
    );
  });

  it('getMessage: defaults, MessageIDs and the leading space before DetailLevel', async () => {
    const e = new Ebay();
    await e.getMessage();
    await e.getMessage('ReturnMessages', ['a', 'b'], '1');
    expect(calls[0].body).toBe(`${HEAD}<GetMyMessagesRequest ${NS}>${CREDS}<FolderID>0</FolderID> <DetailLevel>ReturnHeaders</DetailLevel>${VERSION}</GetMyMessagesRequest>`);
    expect(calls[1].body).toBe(
      `${HEAD}<GetMyMessagesRequest ${NS}>${CREDS}<FolderID>1</FolderID><MessageIDs><MessageID>a</MessageID><MessageID>b</MessageID></MessageIDs>` +
        ` <DetailLevel>ReturnMessages</DetailLevel>${VERSION}</GetMyMessagesRequest>`,
    );
  });

  it('getOrder / getOrders bodies (CreateTime window is app-timezone wall clock labelled Z)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    const e = new Ebay();
    await e.getOrder('O-1');
    await e.getOrders(4);
    expect(calls[0].body).toBe(
      `${HEAD}<GetOrdersRequest ${NS}>${CREDS}<OrderIDArray><OrderID>O-1</OrderID></OrderIDArray><DetailLevel>ReturnAll</DetailLevel>${VERSION}</GetOrdersRequest>`,
    );
    const m = /<CreateTimeFrom>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.000Z<\/CreateTimeFrom><CreateTimeTo>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.000Z<\/CreateTimeTo>/.exec(calls[1].body)!;
    expect(m).not.toBeNull();
    const day = 86400000;
    expect(Date.parse(m[2] + 'Z') - Date.parse(m[1] + 'Z')).toBeGreaterThanOrEqual(90 * day - 3600000);
    expect(Date.parse(m[2] + 'Z') - Date.parse(m[1] + 'Z')).toBeLessThanOrEqual(90 * day + 3600000);
    expect(calls[1].body).toContain(
      `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>4</PageNumber></Pagination><OrderStatus>All</OrderStatus><DetailLevel>ReturnAll</DetailLevel>${VERSION}</GetOrdersRequest>`,
    );
  });

  it('completeSales picks the carrier from the tracking number (Z -> USP, >12 -> USPS, else Fedex)', async () => {
    const e = new Ebay();
    await e.completeSales('I', 'T', 'Z1234');
    await e.completeSales('I', 'T', '9400111899223344556677');
    await e.completeSales('I', 'T', '123456789012');
    const carriers = calls.map((c) => /<ShippingCarrierUsed>(\w+)</.exec(c.body)![1]);
    expect(carriers).toEqual(['USP', 'USPS', 'Fedex']);
    expect(calls[2].headers['X-EBAY-API-CALL-NAME']).toBe('CompleteSale');
    expect(calls[2].body).toBe(
      `${HEAD}<CompleteSaleRequest ${NS}>${CREDS}<ItemID>I</ItemID><Shipment><ShipmentTrackingDetails><ShipmentTrackingNumber>123456789012</ShipmentTrackingNumber>` +
        `<ShippingCarrierUsed>Fedex</ShippingCarrierUsed></ShipmentTrackingDetails></Shipment><Shipped>true</Shipped><TransactionID>T</TransactionID>${VERSION}</CompleteSaleRequest>`,
    );
  });

  it('reviseItemDescription wraps the description in CDATA', async () => {
    await new Ebay().reviseItemDescription('77', '<b>hi & bye</b>');
    expect(calls[0].body).toBe(
      `${HEAD}<ReviseItemRequest ${NS}>${CREDS}<Item><ItemID>77</ItemID><Description><![CDATA[<b>hi & bye</b>]]></Description>` +
        `<DescriptionReviseMode>Replace</DescriptionReviseMode></Item>${VERSION}</ReviseItemRequest>`,
    );
  });

  it("new Ebay('raystore') reads RAYSTORE_* config", async () => {
    await new Ebay('raystore').getItem(5);
    expect(calls[0].url).toBe('https://api.ebay.com/ws/api2.dll');
    expect(calls[0].headers['X-EBAY-API-COMPATIBILITY-LEVEL']).toBe('999');
    expect(calls[0].headers['X-EBAY-API-SITEID']).toBe('3');
    expect(calls[0].body).toContain('<eBayAuthToken>RTOK</eBayAuthToken>');
    expect(calls[0].body).toContain('<Version>999</Version>');
  });

  it("'HTTP 404' or an empty reply dies with the PHP's message", async () => {
    reply = '';
    await expect(new Ebay().getItem(1)).rejects.toThrow('oops<P>Error sending request');
    reply = '<html>Http 404 Not Found</html>';
    await expect(new Ebay().getItem(1)).rejects.toBeInstanceOf(EbayError);
  });

  it('DRY_RUN=1 stops CompleteSale and ReviseItem before the transport; reads still go out', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const e = new Ebay();
    await expect(e.completeSales('I', 'T', 'Z1')).rejects.toThrow('DRY_RUN');
    await expect(e.reviseItemDescription('I', 'd')).rejects.toThrow('DRY_RUN');
    expect(calls).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(2);
    await e.getItem(1);
    expect(calls).toHaveLength(1);
    info.mockRestore();
  });

  it('ebayGetMyMessages (T13 wrapper) still parses <Messages> through the shared request()', async () => {
    reply = `<GetMyMessagesResponse><Ack>Success</Ack><Messages><Message><MessageID>1</MessageID><Sender>bob</Sender></Message></Messages></GetMyMessagesResponse>`;
    const r = await ebayGetMyMessages('ReturnMessages', ['1'], '1');
    expect(r).toEqual({ ack: 'Success', messages: [{ MessageID: '1', Sender: 'bob' }] });
    expect(calls[0].body).toContain('<FolderID>1</FolderID><MessageIDs><MessageID>1</MessageID></MessageIDs> <DetailLevel>ReturnMessages</DetailLevel>');
  });
});

describe('EbayApi (REST)', () => {
  let rest: EbayApiRequest[];
  let replies: (req: EbayApiRequest) => string;

  beforeEach(() => {
    Object.assign(process.env, {
      EBAY_APPID: 'app', EBAY_CERTID: 'cert', EBAY_API_URL: 'https://api.ebay.com', EBAY_OAUTH_REFRESH_TOKEN: 'v^1.1#RT',
    });
    rest = [];
    replies = (req) => (req.url.endsWith('/oauth2/token') ? JSON.stringify({ access_token: 'AT' }) : JSON.stringify({ ok: req.url }));
    setEbayApiTransportForTests(async (req) => {
      rest.push(req);
      return replies(req);
    });
  });
  afterEach(() => setEbayApiTransportForTests(null));

  it('refreshes the OAuth token once, then sends Bearer requests', async () => {
    const api = new EbayApi();
    const r = await api.GetUnshippedOrders();
    await api.GetItemById('v1|123|0', '');
    expect(rest).toHaveLength(3);
    expect(rest[0]).toEqual({
      method: 'POST',
      url: 'https://api.ebay.com/identity/v1/oauth2/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from('app:cert').toString('base64')}` },
      body: 'grant_type=refresh_token&refresh_token=v^1.1#RT&scope=https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.marketing.readonly ' +
        'https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.inventory ' +
        'https://api.ebay.com/oauth/api_scope/sell.account.readonly https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly ' +
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
    });
    expect(rest[1]).toEqual({
      method: 'GET',
      url: 'https://api.ebay.com/sell/fulfillment/v1/order?filter=orderfulfillmentstatus:%7BNOT_STARTED%7CIN_PROGRESS%7D&limit=100&offset=0',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer AT' },
    });
    expect(rest[2].url).toBe('https://api.ebay.com/buy/browse/v1/item/v1|123|0');
    expect(r).toEqual({ ok: rest[1].url });
  });

  it('GetItemByLegacyId appends legacy_variation_id only when $varId is non-empty', async () => {
    const api = new EbayApi();
    await api.GetItemByLegacyId(111, '');
    await api.GetItemByLegacyId(111, '222');
    expect(rest[1].url).toBe('https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=111');
    expect(rest[2].url).toBe('https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=111&legacy_variation_id=222');
  });

  it('a failed token refresh throws "failed to get ebay access token" + json_encode(reply)', async () => {
    replies = () => JSON.stringify({ error: 'invalid_grant' });
    await expect(new EbayApi().GetUnshippedOrders()).rejects.toThrow('failed to get ebay access token{"error":"invalid_grant"}');
    replies = () => 'not json';
    await expect(new EbayApi().GetUnshippedOrders()).rejects.toThrow('failed to get ebay access tokennull');
  });

  it('a non-JSON API reply returns null (json_decode)', async () => {
    replies = (req) => (req.url.endsWith('/oauth2/token') ? JSON.stringify({ access_token: 'AT' }) : '<html>');
    expect(await new EbayApi().GetItemById('x', '')).toBeNull();
  });

  it('UploadShipping posts the PHP heredoc body with carrier + lineItems', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    const api = new EbayApi();
    await api.UploadShipping('12-34567-89012', [{ lineItemId: '1', quantity: 1 }], 'Z99');
    const post = rest[1];
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012/shipping_fulfillment');
    expect(post.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer AT' });
    const ship = /"shippedDate": "([^"]+)\.000Z"/.exec(post.body!)![1];
    expect(post.body).toBe(
      `{\n        "lineItems": [{"lineItemId":"1","quantity":1}],\n        "shippedDate": "${ship}.000Z",\n        "shippingCarrierCode": "USP",\n        "trackingNumber": "Z99"\n    }`,
    );
    expect(ship).toMatch(/^2026-01-0[12]T\d\d:04:05$/);
    await api.UploadShipping('o', [], '9400111899223344556677');
    await api.UploadShipping('o', [], '123456789012');
    expect(rest.slice(2).map((r) => /"shippingCarrierCode": "(\w+)"/.exec(r.body!)![1])).toEqual(['USPS', 'FedEx']);
    vi.useRealTimers();
  });

  it('DRY_RUN=1 stops UploadShipping before any request (not even the token refresh)', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(new EbayApi().UploadShipping('o', [], 'Z1')).rejects.toBeInstanceOf(EbayApiError);
    expect(rest).toHaveLength(0);
    await new EbayApi().GetItemById('x', ''); // reads still go out
    expect(rest).toHaveLength(2);
    info.mockRestore();
    delete process.env.DRY_RUN;
  });

  it("new EbayApi('raystore') uses RAYSTORE_APPID/CERTID/REFRESHTOKEN", async () => {
    Object.assign(process.env, { RAYSTORE_APPID: 'ra', RAYSTORE_CERTID: 'rc', RAYSTORE_REFRESHTOKEN: 'RR', RAYSTORE_API_URL: 'https://api.ebay.com' });
    await new EbayApi('raystore').GetItemById('x', '');
    expect(rest[0].headers.Authorization).toBe(`Basic ${Buffer.from('ra:rc').toString('base64')}`);
    expect(rest[0].body).toContain('refresh_token=RR&');
  });
});
