// L08: App\Libraries\Walmart port. Nothing reaches walmart.com: the transport is mocked at setWalmartTransportForTests.

import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWalmartTransportForTests, Walmart, WalmartDryRunError, WalmartError, type WalmartRequest } from '../src/lib/walmart.js';

let sent: WalmartRequest[];
let replies: Record<string, string | Buffer>; // by "METHOD path-and-query" prefix, longest match wins
const basic = 'Basic ' + Buffer.from('cid:csecret').toString('base64');

const tokenXml = (token = 'tok-1', expiresIn = 900) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:OAuthTokenDTO xmlns:ns2="http://walmart.com/"><accessToken>${token}</accessToken><tokenType>Bearer</tokenType><expiresIn>${expiresIn}</expiresIn></ns2:OAuthTokenDTO>`;

const listXml = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns3:list xmlns:ns2="http://walmart.com/" xmlns:ns3="http://walmart.com/mp/v3/orders">${inner}</ns3:list>`;
const orderEl = (po: string) => `<ns3:order><ns3:purchaseOrderId>${po}</ns3:purchaseOrderId><ns3:orderDate>2024-01-02</ns3:orderDate></ns3:order>`;

beforeEach(() => {
  Object.assign(process.env, {
    WALMART_CLIENT_ID: 'cid',
    WALMART_CLIENT_SECRET: 'csecret',
    WALMART_CHANNEL_TYPE: 'chan-1',
    WALMART_DSV_CHANNEL_TYPE: 'dsv-chan',
    WALMART_DSV_SHIPNODE: '777',
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
afterEach(() => {
  setWalmartTransportForTests(null);
  delete process.env.DRY_RUN;
  delete process.env.STORAGE_DIR;
  vi.restoreAllMocks();
});

describe('token + headers', () => {
  it('fetches a token first (Basic auth, form body), then sends marketplace headers with WM_SEC.ACCESS_TOKEN', async () => {
    replies['GET /v3/orders'] = listXml('');
    await new Walmart().getReleasedOrders('2024-01-02', 'Created');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://marketplace.walmartapis.com/v3/token', body: 'grant_type=client_credentials' });
    expect(sent[0].headers).toMatchObject({
      Authorization: basic,
      Accept: 'application/xml',
      'Content-Type': 'application/x-www-form-urlencoded',
      'WM_SVC.NAME': 'Walmart Marketplace',
    });
    expect(sent[0].headers['WM_QOS.CORRELATION_ID']).toMatch(/^[0-9a-f]{7}$/);
    expect(sent[0].headers).not.toHaveProperty('WM_SVC.VERSION');
    expect(sent[1].method).toBe('GET');
    expect(sent[1].body).toBeUndefined();
    expect(sent[1].headers).toMatchObject({
      Accept: 'application/xml',
      'Content-Type': 'application/xml',
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_SVC.VERSION': '3.0.0',
      'WM_CONSUMER.CHANNEL.TYPE': 'chan-1',
      Authorization: basic,
      'WM_SEC.ACCESS_TOKEN': 'tok-1',
    });
  });

  it('reuses the token within expiry and refreshes it once expired', async () => {
    replies['GET /v3/orders'] = listXml('');
    const w = new Walmart();
    await w.getReleasedOrders('2024-01-02', 'Created');
    await w.getReleasedOrders('2024-01-02', 'Created');
    expect(sent.filter((r) => r.url.endsWith('/token'))).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 901_000);
    replies['POST /v3/token'] = tokenXml('tok-2');
    await w.getReleasedOrders('2024-01-02', 'Created');
    vi.useRealTimers();
    expect(sent.filter((r) => r.url.endsWith('/token'))).toHaveLength(2);
    expect(sent[sent.length - 1].headers['WM_SEC.ACCESS_TOKEN']).toBe('tok-2');
  });

  it('accepts the live API token shape (access_token / expires_in), found by scripts/live-check.ts', async () => {
    replies['POST /v3/token'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><oAuthTokenDTO><access_token>tok-live</access_token><token_type>Bearer</token_type><expires_in>900</expires_in></oAuthTokenDTO>';
    replies['GET /v3/orders'] = listXml('');
    await new Walmart().getReleasedOrders('2024-01-02', 'Created');
    expect(sent[1].headers['WM_SEC.ACCESS_TOKEN']).toBe('tok-live');
    await new Walmart().getReleasedOrders('2024-01-02', 'Created');
    expect(sent.filter((r) => r.url.endsWith('/token'))).toHaveLength(2); // separate instances; token not expired -> each fetched once
  });

  it('an unparseable token reply throws (PHP: property of non-object ErrorException)', async () => {
    replies['POST /v3/token'] = '';
    await expect(new Walmart().getReleasedOrders('2024-01-02', 'Created')).rejects.toBeInstanceOf(WalmartError);
  });
});

describe('orders', () => {
  it('getReleasedOrders: URL, and the ns3:list children (meta + elements.order) with prefixes stripped', async () => {
    replies['GET /v3/orders'] = listXml(`<ns3:meta><ns3:totalCount>2</ns3:totalCount><ns3:limit>100</ns3:limit></ns3:meta><ns3:elements>${orderEl('P1')}${orderEl('P2')}</ns3:elements>`);
    const r = await new Walmart().getReleasedOrders('2024-01-02', 'Created');
    expect(sent[1].url).toBe('https://marketplace.walmartapis.com/v3/orders?status=Created&createdStartDate=2024-01-02&limit=100&productInfo=true');
    expect(r.meta.totalCount).toBe('2');
    expect(r.elements.order.map((o: any) => o.purchaseOrderId)).toEqual(['P1', 'P2']);
  });

  it('a single order is an object, not an array (Runner totalCount == 1 branch)', async () => {
    replies['GET /v3/orders'] = listXml(`<ns3:meta><ns3:totalCount>1</ns3:totalCount></ns3:meta><ns3:elements>${orderEl('P1')}</ns3:elements>`);
    const r = await new Walmart().getReleasedOrders('2024-01-02', 'Cancelled');
    expect(r.elements.order.purchaseOrderId).toBe('P1');
    expect(sent[1].url).toContain('status=Cancelled');
  });

  it('no list in the reply: logs it and returns [] (xpath result)', async () => {
    replies['GET /v3/orders'] = '<ns2:errors xmlns:ns2="http://walmart.com/"><ns2:error><ns2:code>X</ns2:code></ns2:error></ns2:errors>';
    expect(await new Walmart().getReleasedOrders('2024-01-02', 'Created')).toEqual([]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('ns2:errors'));
  });

  it('dsv(): other host, DSV service name/channel, shipNode in the query, still the same token flow', async () => {
    replies['GET /v3/orders'] = listXml('<ns3:meta><ns3:totalCount>0</ns3:totalCount></ns3:meta>');
    const w = new Walmart();
    w.dsv();
    const r = await w.getDsvReleasedOrders('2024-01-02', 'Acknowledged');
    expect(sent[0].url).toBe('https://api-gateway.walmart.com/v3/token');
    expect(sent[0].headers['WM_SVC.NAME']).toBe('Drop Ship Vendor Services');
    expect(sent[1].url).toBe('https://api-gateway.walmart.com/v3/orders?shipNode=777&status=Acknowledged&createdStartDate=2024-01-02&limit=100');
    expect(sent[1].headers).toMatchObject({ 'WM_CONSUMER.CHANNEL.TYPE': 'dsv-chan', 'WM_SVC.NAME': 'Drop Ship Vendor Services' });
    expect(r.meta.totalCount).toBe('0');
  });

  it('getOrder: root ns3 children (purchaseOrderId, shippingInfo...), URL', async () => {
    replies['GET /v3/orders/PO9'] =
      '<ns3:order xmlns:ns3="http://walmart.com/mp/v3/orders"><ns3:purchaseOrderId>PO9</ns3:purchaseOrderId><ns3:shippingInfo><ns3:phone>555</ns3:phone></ns3:shippingInfo></ns3:order>';
    const r = await new Walmart().getOrder('PO9');
    expect(sent[1].url).toBe('https://marketplace.walmartapis.com/v3/orders/PO9');
    expect(r).toEqual({ purchaseOrderId: 'PO9', shippingInfo: { phone: '555' } });
  });

  it('getOrder on junk throws instead of returning garbage', async () => {
    replies['GET /v3/orders/PO9'] = 'nope';
    await expect(new Walmart().getOrder('PO9')).rejects.toBeInstanceOf(WalmartError);
  });
});

describe('acknowledge', () => {
  it('ackOrder: POST with xmlRequest= body; an order reply (no list) -> [] = success', async () => {
    replies['POST /v3/orders/PO1/acknowledge'] = '<ns3:order xmlns:ns3="http://walmart.com/mp/v3/orders"><ns3:purchaseOrderId>PO1</ns3:purchaseOrderId></ns3:order>';
    expect(await new Walmart().ackOrder('PO1')).toEqual([]);
    expect(sent[1]).toMatchObject({ method: 'POST', url: 'https://marketplace.walmartapis.com/v3/orders/PO1/acknowledge', body: 'xmlRequest=' });
    expect(sent[1].headers['Content-Type']).toBe('application/xml');
  });

  it('ackDsvOrder: shipNode query', async () => {
    const w = new Walmart();
    w.dsv();
    replies['POST /v3/orders/PO1/acknowledge'] = '<ns3:order xmlns:ns3="http://walmart.com/mp/v3/orders"/>';
    await w.ackDsvOrder('PO1');
    expect(sent[1].url).toBe('https://api-gateway.walmart.com/v3/orders/PO1/acknowledge?shipNode=777');
    expect(sent[1].body).toBe('xmlRequest=');
  });
});

const line = (tracking: string, extra: object = {}) => ({ lineNumber: 1, lineQty: 2, tracking, tracking_date: '2024-01-02T03:04:05Z', ...extra });

describe('shipOrder / shipDsvOrder (tracking upload)', () => {
  it('shipOrder body: carrier by tracking (1Z -> USP, >12 chars -> USPS, else FedEx), exact XML', async () => {
    replies['POST /v3/orders/PO1/shipping'] = '<ns3:order xmlns:ns3="http://walmart.com/mp/v3/orders"/>';
    const r = await new Walmart().shipOrder('PO1', [line('1Z999AA10123456784'), line('9400111899223197428490'), line('123456789012')]);
    expect(r).toEqual([]);
    expect(sent[1].url).toBe('https://marketplace.walmartapis.com/v3/orders/PO1/shipping');
    const body = sent[1].body!;
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ns2:orderShipment\n    xmlns:ns2="http://walmart.com/mp/v3/orders"\n    xmlns:ns3="http://walmart.com/">\n    <ns2:orderLines><ns2:orderLine>\n            <ns2:lineNumber>1</ns2:lineNumber>')).toBe(true);
    expect([...body.matchAll(/<ns2:carrier>(\w+)<\/ns2:carrier>/g)].map((m) => m[1])).toEqual(['USP', 'USPS', 'FedEx']);
    expect(body).toContain(`                    <ns2:trackingInfo>
                        <ns2:shipDateTime>2024-01-02T03:04:05Z</ns2:shipDateTime>
                        <ns2:carrierName>
                            <ns2:carrier>USP</ns2:carrier>
                        </ns2:carrierName>
                        <ns2:methodCode>Standard</ns2:methodCode>
                        <ns2:trackingNumber>1Z999AA10123456784</ns2:trackingNumber>
                    </ns2:trackingInfo>`);
    expect(body).toContain('<ns2:amount>2</ns2:amount>');
    expect(body.endsWith('</ns2:orderLine></ns2:orderLines></ns2:orderShipment>')).toBe(true);
  });

  it('shipOrder: a non-XML reply returns undefined (PHP `return;`); a list reply is returned as an error', async () => {
    replies['POST /v3/orders/PO1/shipping'] = 'Bad Gateway';
    expect(await new Walmart().shipOrder('PO1', [line('1Z1')])).toBeUndefined();
    replies['POST /v3/orders/PO1/shipping'] = listXml('<ns3:meta><ns3:totalCount>0</ns3:totalCount></ns3:meta>');
    expect((await new Walmart().shipOrder('PO1', [line('1Z1')])).meta.totalCount).toBe('0');
  });

  it('shipDsvOrder body: otherCarrier, carrierMethodCode, trackingURL by carrier', async () => {
    const w = new Walmart();
    w.dsv();
    replies['POST /v3/orders/PO1/shipping'] = '<ns3:order xmlns:ns3="http://walmart.com/mp/v3/orders"/>';
    await w.shipDsvOrder('PO1', [line('1Z999AA10123456784', { code: 'Ground' }), line('9400111899223197428490', { code: 'Std' }), line('123', { code: 'X' })]);
    const body = sent[1].body!;
    expect(sent[1].url).toBe('https://api-gateway.walmart.com/v3/orders/PO1/shipping');
    expect(body).toContain(`                        <ns2:carrierName>
                        <ns2:otherCarrier>USP</ns2:otherCarrier>
                        </ns2:carrierName>
                        <ns2:methodCode>Standard</ns2:methodCode>
                        <ns2:carrierMethodCode>Ground</ns2:carrierMethodCode>
                        <ns2:trackingNumber>1Z999AA10123456784</ns2:trackingNumber>
                        <ns2:trackingURL>https://www.ups.com/</ns2:trackingURL>`);
    expect([...body.matchAll(/<ns2:trackingURL>([^<]+)</g)].map((m) => m[1])).toEqual(['https://www.ups.com/', 'https://www.usps.com/', 'https://www.fedex.com/']);
  });
});

describe('inventory feeds', () => {
  it('updateInventory: POST feeds?feedType=inventory, multipart field "file" with the exact feed XML, application/xml header', async () => {
    replies['POST /v3/feeds'] = '<FeedAcknowledgement><feedId>F1</feedId></FeedAcknowledgement>';
    await new Walmart().updateInventory([
      { sku: 'A-1', qty: 5 },
      { sku: 'B-2', qty: 0 },
    ]);
    expect(sent[1].method).toBe('POST');
    expect(sent[1].url).toBe('https://marketplace.walmartapis.com/v3/feeds?feedType=inventory');
    expect(sent[1].headers['Content-Type']).toBe('application/xml');
    const m = /^--(-{24}[0-9a-f]{16})\r\nContent-Disposition: form-data; name="file"\r\n\r\n([\s\S]*)\r\n--\1--\r\n$/.exec(sent[1].body!);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(`<?xml version="1.0" encoding="UTF-8" ?>
        <InventoryFeed xmlns="http://walmart.com/">
        <InventoryHeader>
        <version>1.4</version>
        </InventoryHeader><inventory>
            <sku>A-1</sku>
            <availabilityCode>AC</availabilityCode>
            <quantity>
            <unit>EACH</unit>
            <amount>5</amount>
            </quantity>
            <fulfillmentLagTime>1</fulfillmentLagTime>
        </inventory><inventory>
            <sku>B-2</sku>
            <availabilityCode>AC</availabilityCode>
            <quantity>
            <unit>EACH</unit>
            <amount>0</amount>
            </quantity>
            <fulfillmentLagTime>1</fulfillmentLagTime>
        </inventory></InventoryFeed>`);
  });

  it('updateDsvInventory: DSV host and shipNode in the feed URL', async () => {
    const w = new Walmart();
    w.dsv();
    await w.updateDsvInventory([{ sku: 'D-1', qty: 3 }]);
    expect(sent[1].url).toBe('https://api-gateway.walmart.com/v3/feeds?feedType=inventory&shipNode=777');
  });
});

describe('DRY_RUN=1', () => {
  it('ack, ship and inventory writes never reach the transport (not even the token call); GET still does', async () => {
    process.env.DRY_RUN = '1';
    const w = new Walmart();
    await expect(w.ackOrder('PO1')).rejects.toBeInstanceOf(WalmartDryRunError);
    await expect(w.shipOrder('PO1', [line('1Z1')])).rejects.toBeInstanceOf(WalmartDryRunError);
    await expect(w.updateInventory([{ sku: 'A', qty: 1 }])).rejects.toBeInstanceOf(WalmartDryRunError);
    const d = new Walmart();
    d.dsv();
    await expect(d.shipDsvOrder('PO1', [line('1Z1', { code: 'G' })])).rejects.toBeInstanceOf(WalmartDryRunError);
    await expect(d.updateDsvInventory([{ sku: 'A', qty: 1 }])).rejects.toBeInstanceOf(WalmartDryRunError);
    expect(sent).toHaveLength(0);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('[DRY_RUN] Walmart POST'), expect.anything());
    replies['GET /v3/orders'] = listXml('');
    await w.getReleasedOrders('2024-01-02', 'Created');
    expect(sent.map((r) => r.method)).toEqual(['POST', 'GET']); // token + read
  });
});

// ---- item report: storage/app/walmart_items.zip -> storage/app/walmart/*.csv ----

function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = Buffer.from(name);
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, data);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('getItemReport', () => {
  it('downloads the zip (GET getReport?type=item), clears old walmart* files, returns the csv rows via str_getcsv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'l08-'));
    process.env.STORAGE_DIR = dir;
    await mkdir(join(dir, 'app/walmart'), { recursive: true });
    await writeFile(join(dir, 'app/walmart/stale.csv'), 'old\n');
    replies['GET /v3/getReport'] = zipOf({
      'readme.txt': 'x',
      'items.csv': 'SKU,Name,Price\nA-1,"Big, Red ""Box""",9.99\r\nB-2,Plain,1\n\nlast,row',
    });
    const rows = await new Walmart().getItemReport();
    expect(sent[1]).toMatchObject({ method: 'GET', url: 'https://marketplace.walmartapis.com/v3/getReport?type=item' });
    expect(rows).toEqual([['SKU', 'Name', 'Price'], ['A-1', 'Big, Red "Box"', '9.99'], ['B-2', 'Plain', '1'], [null], ['last', 'row']]);
    await expect(access(join(dir, 'app/walmart/stale.csv'))).rejects.toThrow();
    await rm(dir, { recursive: true });
  });

  it('a reply that is not a zip yields []', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'l08-'));
    process.env.STORAGE_DIR = dir;
    replies['GET /v3/getReport'] = '<error/>';
    expect(await new Walmart().getItemReport()).toEqual([]);
    expect((await readFile(join(dir, 'app/walmart_items.zip'))).toString()).toBe('<error/>');
    await rm(dir, { recursive: true });
  });
});

describe('getDsvItems', () => {
  it('returns the ns2:ItemResponses children (totalItems, ItemResponse[])', async () => {
    const w = new Walmart();
    w.dsv();
    replies['GET /v3/items'] =
      '<ns2:ItemResponses xmlns:ns2="http://walmart.com/"><ns2:totalItems>2</ns2:totalItems><ns2:ItemResponse><ns2:sku>S1</ns2:sku><ns2:price><ns2:amount>1.5</ns2:amount></ns2:price></ns2:ItemResponse><ns2:ItemResponse><ns2:sku>S2</ns2:sku></ns2:ItemResponse></ns2:ItemResponses>';
    const r = await w.getDsvItems();
    expect(sent[1].url).toBe('https://api-gateway.walmart.com/v3/items');
    expect(r.totalItems).toBe('2');
    expect(r.ItemResponse.map((i: any) => i.sku)).toEqual(['S1', 'S2']);
    expect(r.ItemResponse[0].price.amount).toBe('1.5');
  });
});
