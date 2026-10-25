// L13: read-only allow-list for scripts/live-check.ts. Everything not listed here is refused (default deny),
// so a write/purchase/upload/mail call cannot go out even if a client method is wired to one by mistake.

export class ReadOnlyViolation extends Error {}

export interface OutboundCall {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

// eBay Trading API verbs (X-EBAY-API-CALL-NAME).
export const TRADING_READ_VERBS = new Set(['GeteBayOfficialTime', 'GetItem', 'GetMyeBaySelling', 'GetOrders', 'GetMyMessages', 'GetSellingManagerSoldListings']);
export const HOUZZ_READ_METHODS = new Set(['getOrders', 'getListing']);
export const USPS_READ_APIS = new Set(['RateV4', 'Verify', 'CityStateLookup', 'ZipCodeLookup', 'TrackV2']);
export const UPS_READ_PATHS = new Set(['/ups.app/xml/XAV', '/ups.app/xml/Rate', '/ups.app/xml/Track']);

// SOAP operations (node-soap does not go through fetch, so the script guards the client's transport seam).
export const SOAP_READ_OPERATIONS: Record<'stamps' | 'fedex' | 'frayun', ReadonlySet<string>> = {
  stamps: new Set(['GetAccountInfo', 'CleanseAddress', 'GetRates']),
  fedex: new Set(['getRates', 'addressValidation']),
  frayun: new Set(['GetBalance']),
};

const WALMART_HOSTS = new Set(['marketplace.walmartapis.com', 'api-gateway.walmart.com']);

const refuse = (call: OutboundCall, why: string): never => {
  const u = new URL(call.url);
  throw new ReadOnlyViolation(`live-check refused ${call.method.toUpperCase()} ${u.host}${u.pathname}: ${why}`);
};

const header = (call: OutboundCall, name: string): string =>
  Object.entries(call.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? '';

// Throws ReadOnlyViolation unless the HTTP call is a known read (or the auth step that precedes reads).
export function assertReadOnlyHttp(call: OutboundCall): void {
  const method = call.method.toUpperCase();
  const url = new URL(call.url);
  const isGet = method === 'GET' || method === 'HEAD';
  const { hostname: host, pathname: path } = url;
  if (url.protocol !== 'https:') refuse(call, 'https only');

  if (host === 'api.ebay.com') {
    if (path === '/ws/api.dll') {
      const verb = header(call, 'X-EBAY-API-CALL-NAME');
      if (method === 'POST' && TRADING_READ_VERBS.has(verb)) return;
      return refuse(call, `Trading verb "${verb}" not allow-listed`);
    }
    if (method === 'POST' && path === '/identity/v1/oauth2/token') return; // OAuth refresh-token exchange
    if (isGet) return;
    return refuse(call, 'eBay REST is GET-only');
  }
  if (host === 'api.amazon.com') {
    if (method === 'POST' && path === '/auth/o2/token') return; // LWA
    return refuse(call, 'only the LWA token call is allowed');
  }
  if (host === 'sts.us-east-1.amazonaws.com') {
    // The client sends Action in the query string; the body form is accepted too.
    if (method === 'POST' && (url.searchParams.get('Action') === 'AssumeRole' || /(^|&)Action=AssumeRole(&|$)/.test(call.body ?? ''))) return;
    return refuse(call, 'only STS AssumeRole is allowed');
  }
  if (host === 'sellingpartnerapi-na.amazon.com') return isGet ? undefined : refuse(call, 'SP-API is GET-only');
  if (WALMART_HOSTS.has(host)) {
    if (isGet || (method === 'POST' && path === '/v3/token')) return;
    return refuse(call, 'Walmart is GET-only apart from /v3/token');
  }
  if (host.endsWith('.myshopify.com')) return isGet ? undefined : refuse(call, 'Shopify is GET-only');
  if (host === 'api.houzz.com') {
    const m = url.searchParams.get('method') ?? '';
    return isGet && HOUZZ_READ_METHODS.has(m) ? undefined : refuse(call, `Houzz method "${m}" not allow-listed`);
  }
  if (host === 'openapi.etsy.com') return isGet ? undefined : refuse(call, 'Etsy is GET-only');
  if (host === 'onlinetools.ups.com' || host === 'wwwcie.ups.com') {
    return method === 'POST' && UPS_READ_PATHS.has(path) ? undefined : refuse(call, 'UPS endpoint not allow-listed');
  }
  if (host === 'secure.shippingapis.com') {
    const api = url.searchParams.get('API') ?? '';
    return isGet && USPS_READ_APIS.has(api) ? undefined : refuse(call, `USPS API "${api}" not allow-listed`);
  }
  return refuse(call, 'host not allow-listed');
}

export function assertReadOnlyOperation(integration: keyof typeof SOAP_READ_OPERATIONS, operation: string): void {
  if (!SOAP_READ_OPERATIONS[integration].has(operation)) {
    throw new ReadOnlyViolation(`live-check refused ${integration} SOAP operation "${operation}"`);
  }
}

// Wraps fetch so every HTTP call is checked first; `log` receives "METHOD host/path -> status" (no query, no headers).
export function guardFetch(inner: typeof fetch, log: (line: string) => void): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
    const call: OutboundCall = {
      method: init?.method ?? req?.method ?? 'GET',
      url: req ? req.url : String(input),
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    assertReadOnlyHttp(call);
    const u = new URL(call.url);
    const res = await inner(input, init);
    log(`${call.method.toUpperCase()} ${u.host}${u.pathname} -> ${res.status}`);
    return res;
  }) as typeof fetch;
}
