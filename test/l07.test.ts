// L07: App\Libraries\Shopify port. Nothing reaches shopify.com: the transport is mocked at setShopifyTransportForTests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setShopifyTransportForTests, Shopify, ShopifyCurlError, ShopifyDryRunError, type ShopifyRequest } from '../src/lib/shopify.js';

let sent: ShopifyRequest[];
let reply: { status?: number; reason?: string; headers?: Record<string, string>; body: string };

beforeEach(() => {
  Object.assign(process.env, { SHOPIFY_API_KEY: 'key123', SHOPIFY_PASSWORD: 'pw456', SHOPIFY_DOMAIN: 'my-shop' });
  delete process.env.DRY_RUN;
  sent = [];
  reply = { body: '{}' };
  setShopifyTransportForTests(async (req) => {
    sent.push(req);
    return { status: reply.status ?? 200, reason: reply.reason ?? 'OK', headers: reply.headers ?? {}, body: reply.body };
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  setShopifyTransportForTests(null);
  delete process.env.DRY_RUN;
  vi.restoreAllMocks();
});

const basic = 'Basic ' + Buffer.from('key123:pw456').toString('base64');

describe('Shopify.call', () => {
  it('GET: base url from env, leading slash trimmed, params as query, Basic auth + user agent, no body', async () => {
    reply.body = JSON.stringify({ orders: [{ id: 1, name: '#1001' }, { id: 2 }] });
    const r = await new Shopify().call('GET', '/admin/orders.json', { limit: '250', financial_status: 'paid', fulfillment_status: 'unshipped' });
    expect(r).toEqual([{ id: 1, name: '#1001' }, { id: 2 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe('https://my-shop.myshopify.com/admin/orders.json?limit=250&financial_status=paid&fulfillment_status=unshipped');
    expect(sent[0].headers).toEqual({ 'User-Agent': 'ohShopify-php-api-client', Authorization: basic });
    expect(sent[0].body).toBeUndefined();
  });

  it('GET with a query already in the path and empty params appends nothing (Runner@RefreshShopifyProducts)', async () => {
    reply.body = '{"products":[]}';
    await new Shopify().call('GET', 'admin/products.json?limit=250&page_info=abc', []);
    expect(sent[0].url).toBe('https://my-shop.myshopify.com/admin/products.json?limit=250&page_info=abc');
  });

  it('GET without params argument and http_build_query encoding (space -> +)', async () => {
    await new Shopify().call('GET', 'admin/products/count.json');
    await new Shopify().call('GET', 'admin/x.json', { title: 'a b&c' });
    expect(sent[0].url).toBe('https://my-shop.myshopify.com/admin/products/count.json');
    expect(sent[1].url).toBe('https://my-shop.myshopify.com/admin/x.json?title=a+b%26c');
  });

  it('DELETE sends params as query, no body', async () => {
    await new Shopify().call('DELETE', 'admin/custom_collections/9.json');
    await new Shopify().call('DELETE', 'admin/products.json', { ids: '5' });
    expect(sent[0]).toMatchObject({ method: 'DELETE', url: 'https://my-shop.myshopify.com/admin/custom_collections/9.json' });
    expect(sent[1].url).toBe('https://my-shop.myshopify.com/admin/products.json?ids=5');
    expect(sent[1].body).toBeUndefined();
  });

  it('POST: json body, Content-Type header, unchanged url (params are not a query)', async () => {
    reply.body = JSON.stringify({ product: { id: 77 } });
    const r = await new Shopify().call('POST', 'admin/products.json', { product: { title: 'Chair', variants: [{ price: '9.99', option1: 'Default' }] } });
    expect(r).toEqual({ id: 77 });
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe('https://my-shop.myshopify.com/admin/products.json');
    expect(sent[0].headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(sent[0].headers.Authorization).toBe(basic);
    expect(sent[0].body).toBe('{"product":{"title":"Chair","variants":[{"price":"9.99","option1":"Default"}]}}');
  });

  it('POST/PUT payload = stripslashes(json_encode(params)): "/" unescaped, non-ASCII loses its backslash, \\" loses it too', async () => {
    const s = new Shopify();
    await s.call('PUT', 'admin/products/5.json', { product: { body_html: '<a href="x/y">é</a>', note: 'a/b' } });
    // json_encode gives {"body_html":"<a href=\"x\/y\">\u00e9<\/a>"...}; stripslashes then drops every backslash
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].body).toBe('{"product":{"body_html":"<a href="x/y">u00e9</a>","note":"a/b"}}');
  });

  it('POST with empty params sends "[]" (PHP array())', async () => {
    await new Shopify().call('POST', 'admin/x.json');
    expect(sent[0].body).toBe('[]');
    expect(sent[0].headers['Content-Type']).toBe('application/json; charset=utf-8');
  });

  it('fulfillment POST is the same call shape the Unshipped controller uses', async () => {
    await new Shopify().call('POST', 'admin/orders/123/fulfillments.json', { fulfillment: { tracking_number: '9400', tracking_company: 'USPS', notify_customer: true } });
    expect(sent[0].url).toBe('https://my-shop.myshopify.com/admin/orders/123/fulfillments.json');
    expect(sent[0].body).toBe('{"fulfillment":{"tracking_number":"9400","tracking_company":"USPS","notify_customer":true}}');
  });

  it('return value is array_shift of the decoded reply', async () => {
    const s = new Shopify();
    reply.body = '{"count":42}';
    expect(await s.call('GET', 'admin/products/count.json')).toBe(42);
    reply.body = '[{"a":1},{"b":2}]'; // top-level list
    expect(await s.call('GET', 'x')).toEqual({ a: 1 });
    reply.body = '{}';
    expect(await s.call('GET', 'x')).toEqual([]);
    reply.body = '[]';
    expect(await s.call('GET', 'x')).toEqual([]);
    reply.body = 'not json';
    expect(await s.call('GET', 'x')).toBeNull();
    reply.body = '"str"';
    expect(await s.call('GET', 'x')).toBe('str');
  });

  it('errors key or status >= 400 is logged, never thrown', async () => {
    const s = new Shopify();
    reply = { status: 422, reason: 'Unprocessable Entity', body: '{"errors":{"title":["can\'t be blank"]}}' };
    expect(await s.call('POST', 'admin/products.json', { product: {} })).toEqual({ title: ["can't be blank"] });
    expect(console.info).toHaveBeenCalledWith({ errors: { title: ["can't be blank"] } });
    vi.mocked(console.info).mockClear();
    reply = { status: 500, reason: 'Server Error', body: '' };
    expect(await s.call('GET', 'x')).toBeNull();
    expect(console.info).toHaveBeenCalledTimes(1);
    vi.mocked(console.info).mockClear();
    reply = { status: 200, body: '{"orders":[]}' };
    await s.call('GET', 'x');
    expect(console.info).not.toHaveBeenCalled();
  });

  it('keeps the last reply headers (link pagination) in the PHP curlParseHeaders shape', async () => {
    const s = new Shopify();
    expect(s.lastResponseHeaders).toBeNull();
    reply.headers = { link: '<https://my-shop.myshopify.com/admin/products.json?page_info=n>; rel="next"', 'x-shopify-shop-api-call-limit': '3/40' };
    await s.call('GET', 'admin/products.json');
    expect(s.lastResponseHeaders).toEqual({
      http_status_code: '200',
      http_status_message: 'OK',
      link: '<https://my-shop.myshopify.com/admin/products.json?page_info=n>; rel="next"',
      'x-shopify-shop-api-call-limit': '3/40',
    });
  });

  it('transport failure -> ShopifyCurlError (PHP ShopifyCurlException)', async () => {
    setShopifyTransportForTests(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(new Shopify().call('GET', 'x')).rejects.toThrow(ShopifyCurlError);
  });
});

describe('DRY_RUN', () => {
  it.each([
    ['POST', 'admin/products.json'],
    ['PUT', 'admin/products/1.json'],
    ['DELETE', 'admin/products/1.json'],
  ])('%s is logged and never reaches the transport', async (method, path) => {
    process.env.DRY_RUN = '1';
    await expect(new Shopify().call(method, path, { product: { title: 't' } })).rejects.toThrow(ShopifyDryRunError);
    expect(sent).toHaveLength(0);
    expect(vi.mocked(console.info).mock.calls[0][0]).toContain('[DRY_RUN] Shopify');
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('pw456');
  });

  it('GET is a read and is still sent', async () => {
    process.env.DRY_RUN = '1';
    await new Shopify().call('GET', 'admin/orders.json');
    expect(sent).toHaveLength(1);
  });
});

describe('real transport guard', () => {
  it('refuses hosts outside *.myshopify.com before any network call', async () => {
    setShopifyTransportForTests(null);
    process.env.SHOPIFY_DOMAIN = 'evil.com/x#';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(new Shopify().call('GET', 'x')).rejects.toThrow(ShopifyCurlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
