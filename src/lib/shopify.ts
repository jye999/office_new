// Port of the old app's App\Libraries\Shopify (ohShopify-php-api-client over curl, HTTP Basic "private app" auth:
// https://<ApiKey>:<Password>@<Domain>.myshopify.com). curl turned the URL userinfo into a Basic Authorization header;
// fetch refuses credentials in URLs, so the header is sent explicitly and `shopDomain` carries no credentials.
// Ported (the only method with callers): call(). The headers of the last reply are kept in `lastResponseHeaders`
// (PHP: public $last_response_headers; Runner@RefreshShopifyProducts reads ['link'] for pagination).
// Skipped (no caller anywhere in app/): getAuthorizeUrl, getAccessToken, callsMade, callLimit, callsLeft,
// validateSignature, ShopifyApiException (its throw is commented out in PHP).
//
// Every outbound call goes through request(). Any non-GET call (POST/PUT/DELETE: product/collection/collect writes,
// fulfillments = uploading tracking) is logged and NOT sent when DRY_RUN=1.

import { json_encode } from '../view.js';
import { httpBuildQuery } from './etsy.js';

export class ShopifyCurlError extends Error {}
export class ShopifyDryRunError extends Error {}

export interface ShopifyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ShopifyResponse {
  status: number;
  reason: string;
  headers: Record<string, string>; // lower-cased names
  body: string;
}

type ShopifyTransport = (req: ShopifyRequest) => Promise<ShopifyResponse>;

const fetchTransport: ShopifyTransport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.myshopify.com')) {
    throw new ShopifyCurlError(`Shopify: host not allowed: ${url.hostname}`);
  }
  const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(120_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
  return { status: res.status, reason: res.statusText, headers, body: await res.text() };
};

let transport: ShopifyTransport = fetchTransport;

// Test seam so unit tests never call shopify.com.
export function setShopifyTransportForTests(fn: ShopifyTransport | null): void {
  transport = fn ?? fetchTransport;
}

// The single outbound seam.
export function request(req: ShopifyRequest): Promise<ShopifyResponse> {
  return transport(req);
}

// PHP stripslashes(): `\\` -> `\`, `\0` -> NUL, any other `\x` -> `x`, a trailing lone `\` is dropped.
function stripslashes(s: string): string {
  return s.replace(/\\(.?)/gs, (_m, c: string) => (c === '0' ? '\0' : c));
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'object' && Object.keys(v as object).length === 0);

export class Shopify {
  shopDomain: string;
  lastResponseHeaders: Record<string, string> | null = null;
  private apiKey: string;
  private password: string;

  constructor() {
    this.apiKey = process.env.SHOPIFY_API_KEY ?? '';
    this.password = process.env.SHOPIFY_PASSWORD ?? '';
    this.shopDomain = `https://${process.env.SHOPIFY_DOMAIN ?? ''}.myshopify.com`;
  }

  // Returns the first element of the decoded reply (PHP array_shift: `{"products":[..]}` -> the list), the decoded
  // value itself when it is empty/scalar, or null for a non-JSON body. Failures are only logged, never thrown.
  async call(method: string, path: string, params: Record<string, unknown> | unknown[] = []): Promise<any> {
    let url = `${this.shopDomain}/${path.replace(/^\/+/, '')}`;
    const query = method === 'GET' || method === 'DELETE' ? params : [];
    const payload = method === 'POST' || method === 'PUT' ? stripslashes(isEmpty(params) ? '[]' : json_encode(params)) : '';
    const headers: Record<string, string> = {
      'User-Agent': 'ohShopify-php-api-client',
      Authorization: 'Basic ' + Buffer.from(`${this.apiKey}:${this.password}`).toString('base64'),
    };
    if (payload !== '') Object.assign(headers, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!isEmpty(query)) url += `?${httpBuildQuery(query as Record<string, unknown>)}`;

    if (method !== 'GET' && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] Shopify ${method} ${url} not sent`, payload);
      throw new ShopifyDryRunError(`DRY_RUN: Shopify ${method} ${path} not sent`);
    }

    let res: ShopifyResponse;
    try {
      res = await request({ method, url, headers, body: payload !== '' ? payload : undefined });
    } catch (e) {
      throw e instanceof ShopifyCurlError ? e : new ShopifyCurlError((e as Error).message);
    }
    this.lastResponseHeaders = { http_status_code: String(res.status), http_status_message: res.reason, ...res.headers };

    let decoded: any = null;
    try {
      decoded = JSON.parse(res.body);
    } catch {
      // json_decode failure -> null
    }
    if ((decoded !== null && typeof decoded === 'object' && decoded.errors != null) || res.status >= 400) {
      console.info(decoded);
    }
    if (decoded !== null && typeof decoded === 'object') {
      const values = Object.values(decoded);
      return values.length > 0 ? values[0] : [];
    }
    return decoded;
  }
}
