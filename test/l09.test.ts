// L09: App\Libraries\Houzz + Wayfair ports. Nothing reaches houzz.com / wayfair.com: both are mocked at their request() seam.
// test/fixtures/l09-wayfair-php-golden.json holds the requests the real PHP class built (run with a stubbed sendRequest,
// config() and Debugbar, clock 2026-10-24 UTC); the Houzz URLs below were captured from the PHP against a loopback server.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// storage.ts reads STORAGE_DIR at import time
const storageDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'l09-storage-'));
  process.env.STORAGE_DIR = dir;
  return dir;
});

import { Houzz, HouzzDryRunError, setHouzzTransportForTests, type HouzzRequest } from '../src/lib/houzz.js';
import { Wayfair, WayfairDryRunError, WayfairError, setWayfairTransportForTests, type WayfairRequest } from '../src/lib/wayfair.js';

const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures/l09-wayfair-php-golden.json'), 'utf8'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  Object.assign(process.env, {
    HOUZZ_API_URL: 'http://127.0.0.1:8765/api',
    HOUZZ_DATA_FORMAT: 'json',
    HOUZZ_APP_ID: 'APP',
    HOUZZ_USERNAME: 'USER',
    HOUZZ_TOKEN: 'TOK',
    WAYFAIR_API_URL: 'https://api.wayfair.test/v1/graphql',
    WAYFAIR_CLIENT: 'cid',
    WAYFAIR_SECRET: 'sec',
    WAYFAIR_AUDIENCE: 'https://api.wayfair.test',
  });
  delete process.env.DRY_RUN;
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  setHouzzTransportForTests(null);
  setWayfairTransportForTests(null);
  delete process.env.DRY_RUN;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const houzzHeaders = { 'X-HOUZZ-API-SSL-TOKEN': 'TOK', 'X-HOUZZ-API-USER-NAME': 'USER', 'X-HOUZZ-API-APP-NAME': 'APP', 'User-Agent': 'Chrome' };

describe('Houzz', () => {
  let sent: HouzzRequest[];
  beforeEach(() => {
    sent = [];
    setHouzzTransportForTests(async (req) => {
      sent.push(req);
      return '{"Ack":"Success"}';
    });
  });

  it('sends the same GET URLs and headers as the PHP, returning the raw body', async () => {
    const h = new Houzz();
    expect(await h.getUnshippedOrders()).toBe('{"Ack":"Success"}');
    await h.getShippedOrders();
    await h.shipOrder('1594-0662 &x~(1)*');
    await h.getShippingLabel('A/B');
    await h.getProduct('p 1');
    expect(sent.map((r) => r.url)).toEqual([
      'http://127.0.0.1:8765/api?format=json&method=getOrders&&Status=Active',
      'http://127.0.0.1:8765/api?format=json&method=getOrders&&Status=Shipped&From=2026-10-14',
      'http://127.0.0.1:8765/api?format=json&method=updateOrder&&OrderId=1594-0662%20%26x~%281%29%2A&Action=Ship',
      'http://127.0.0.1:8765/api?format=json&method=getShippingLabel&&OrderId=A%2FB',
      'http://127.0.0.1:8765/api?format=json&method=getListing&&ProductId=p%201',
    ]);
    for (const r of sent) {
      expect(r.method).toBe('GET');
      expect(r.headers).toEqual(houzzHeaders);
    }
  });

  it('returns false (curl_exec failure) when the transfer fails', async () => {
    setHouzzTransportForTests(async () => {
      throw new Error('boom');
    });
    expect(await new Houzz().getUnshippedOrders()).toBe(false);
  });

  it('DRY_RUN=1 blocks shipOrder only', async () => {
    process.env.DRY_RUN = '1';
    const h = new Houzz();
    await expect(h.shipOrder('1')).rejects.toBeInstanceOf(HouzzDryRunError);
    expect(sent).toHaveLength(0);
    await h.getShippingLabel('1');
    await h.getUnshippedOrders();
    expect(sent).toHaveLength(2);
  });
});

describe('Wayfair', () => {
  let sent: WayfairRequest[];
  let replies: Array<{ status?: number; body: string }>;
  const asPhpLog = (reqs: WayfairRequest[]) =>
    reqs.map((r) => ({
      method: r.method,
      url: r.url,
      headers: Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`),
      body: r.body ?? '',
    }));

  beforeEach(() => {
    sent = [];
    replies = [];
    setWayfairTransportForTests(async (req) => {
      sent.push(req);
      const r = replies.shift() ?? { body: '{}' };
      return { status: r.status ?? 200, body: Buffer.from(r.body) };
    });
  });

  const order = { orderId: 'CS123' };
  const lines = [
    { sku: 'SKU-1', qty: 2, price: '10.50', promiseDate: '2024-05-06 00:00:00', shipLevel: 'GROUND' },
    { sku: 'SKU-2', qty: 1, price: 5, promiseDate: '2024-05-07 12:00:00', shipLevel: 'GROUND' },
  ];
  const items = [
    { ItemNumber: 'A-1', ItemQuantityOnHand: 5 },
    { ItemNumber: 'B-2', ItemQuantityOnHand: 0 },
  ];

  it('fetchToken: same auth request as the PHP, returns and remembers the access token', async () => {
    replies = [{ body: '{"access_token":"TOK"}' }];
    const w = new Wayfair();
    expect(await w.fetchToken()).toBe('TOK');
    expect(asPhpLog(sent)).toEqual(golden.fetchToken.log);
    await w.getInventory();
    expect(sent[1].headers.Authorization).toBe('Bearer TOK');
  });

  it('fetchToken failure throws WayfairError (PHP echoed and exit(1))', async () => {
    replies = [{ status: 401, body: 'nope' }];
    await expect(new Wayfair().fetchToken()).rejects.toThrow('Could not retrieve a token for the request: Request failed with status code 401, response nope');
  });

  it.each([
    ['getOrders', (w: Wayfair) => w.getOrders()],
    ['getInventory', (w: Wayfair) => w.getInventory()],
    ['acceptOrder', (w: Wayfair) => w.acceptOrder(order, lines)],
    ['rejectOrder', (w: Wayfair) => w.rejectOrder(order, lines)],
    ['updateFullInventory', (w: Wayfair) => w.updateFullInventory(items)],
    ['updateInventory', (w: Wayfair) => w.updateInventory(items)],
    ['GetPackingSlip', (w: Wayfair) => w.GetPackingSlip('CS123')],
  ])('%s sends the request the PHP built (URL, headers, flattened GraphQL body)', async (name, call) => {
    await call(new Wayfair('TOK'));
    expect(asPhpLog(sent)).toEqual(golden[name === 'GetPackingSlip' ? 'packingSlip' : name]);
  });

  it('acceptOrder with no lines returns "" and sends nothing', async () => {
    expect(await new Wayfair('TOK').acceptOrder(order, [])).toBe('');
    expect(sent).toHaveLength(0);
    expect(golden.acceptOrderEmpty).toEqual({ ret: '', log: [] });
  });

  it('GraphQL replies are json-decoded; a non-200 throws WayfairError', async () => {
    replies = [{ body: '{"data":{"inventory":[]}}' }];
    expect(await new Wayfair('TOK').getInventory()).toEqual({ data: { inventory: [] } });
    replies = [{ status: 500, body: 'oops' }];
    await expect(new Wayfair('TOK').getInventory()).rejects.toBeInstanceOf(WayfairError);
  });

  it('RegisterOrder without a label returns the GraphQL reply', async () => {
    replies = [{ body: '{"data":{"purchaseOrders":{"register":{"consolidatedShippingLabel":null}}}}' }];
    const r = await new Wayfair('TOK').RegisterOrder('CS123');
    expect(r).toEqual({ data: { purchaseOrders: { register: { consolidatedShippingLabel: null } } } });
    expect(asPhpLog(sent)).toEqual(golden.registerNoLabel.log);
  });

  it('RegisterOrder with a label downloads it with the bearer token and saves labels/<po>.pdf (0666)', async () => {
    replies = [
      { body: '{"data":{"purchaseOrders":{"register":{"consolidatedShippingLabel":{"url":"https://label.test/x.pdf"}}}}}' },
      { body: '%PDF-fake' },
    ];
    expect(await new Wayfair('TOK').RegisterOrder('CS123')).toBe('CS123');
    expect(asPhpLog(sent)).toEqual(golden.registerLabel.log);
    const file = join(storageDir, 'app/public/labels/labels/CS123.pdf');
    expect(readFileSync(file, 'utf8')).toBe(golden.registerLabel.file);
  });

  it('DRY_RUN=1 blocks every mutation before HTTP; token, queries and packing slip still go out', async () => {
    process.env.DRY_RUN = '1';
    const w = new Wayfair('TOK');
    for (const call of [() => w.acceptOrder(order, lines), () => w.rejectOrder(order, lines), () => w.updateFullInventory(items), () => w.updateInventory(items), () => w.RegisterOrder('CS123')]) {
      await expect(call()).rejects.toBeInstanceOf(WayfairDryRunError);
    }
    expect(sent).toHaveLength(0);
    await w.getOrders();
    await w.getInventory();
    await w.GetPackingSlip('CS123');
    replies = [{ body: '{"access_token":"T2"}' }];
    await new Wayfair().fetchToken();
    expect(sent).toHaveLength(4);
  });
});
