// Port of the old app's App\Libraries\Houzz (Houzz Pro Marketplace API over curl GET).
// Ported (the methods with callers): getUnshippedOrders, getShippedOrders, shipOrder, getShippingLabel, getProduct,
// plus httpGet and its query helpers. Callers json_decode() the raw reply string, so every method returns the raw body
// (`false` when the transfer fails, like curl_exec).
// Skipped (no caller in app/): getOrder, httpPost.
//
// Every outbound call goes through request(). shipOrder (`updateOrder` Action=Ship, a GET in the Houzz API) marks the
// order shipped at Houzz, so it is logged and NOT sent when DRY_RUN=1.

import { date } from '../view.js';

export class HouzzDryRunError extends Error {}

export interface HouzzRequest {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}

type HouzzTransport = (req: HouzzRequest) => Promise<string>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchTransport: HouzzTransport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:' || url.hostname !== 'api.houzz.com') {
    throw new Error(`Houzz: host not allowed: ${url.hostname}`);
  }
  const res = await fetch(url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(120_000) });
  const body = await res.text();
  await sleep(500); // PHP: usleep(500000) after every call (rate limit)
  return body;
};

let transport: HouzzTransport = fetchTransport;

// Test seam so unit tests never call houzz.com.
export function setHouzzTransportForTests(fn: HouzzTransport | null): void {
  transport = fn ?? fetchTransport;
}

// The single outbound seam.
export function request(req: HouzzRequest): Promise<string> {
  return transport(req);
}

export class Houzz {
  private apiUrl = process.env.HOUZZ_API_URL ?? '';
  private dataFormat = process.env.HOUZZ_DATA_FORMAT ?? '';
  private appId = process.env.HOUZZ_APP_ID ?? '';
  private userName = process.env.HOUZZ_USERNAME ?? '';
  private token = process.env.HOUZZ_TOKEN ?? '';

  getUnshippedOrders() {
    return this.httpGet('getOrders', { Status: 'Active' });
  }

  getShippedOrders() {
    return this.httpGet('getOrders', { Status: 'Shipped', From: date('Y-m-d', Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 10) });
  }

  shipOrder(orderId: unknown) {
    return this.httpGet('updateOrder', { OrderId: orderId, Action: 'Ship' }, true);
  }

  getShippingLabel(orderId: unknown) {
    return this.httpGet('getShippingLabel', { OrderId: orderId });
  }

  getProduct(productId: unknown) {
    return this.httpGet('getListing', { ProductId: productId });
  }

  urlencode(value: unknown): string {
    return encodeURIComponent(String(value ?? '')).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }

  getParametersAsString(parameters: Record<string, unknown>): string {
    return Object.entries(parameters)
      .map(([key, value]) => `${key}=${this.urlencode(value)}`)
      .join('&');
  }

  async httpGet(method: string, parameters: Record<string, unknown>, write = false): Promise<string | false> {
    const url = `${this.apiUrl}?format=${this.dataFormat}&method=${method}&` + '&' + this.getParametersAsString(parameters);
    const headers = {
      'X-HOUZZ-API-SSL-TOKEN': this.token,
      'X-HOUZZ-API-USER-NAME': this.userName,
      'X-HOUZZ-API-APP-NAME': this.appId,
      'User-Agent': 'Chrome',
    };
    if (write && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] Houzz GET ${url} not sent`);
      throw new HouzzDryRunError(`DRY_RUN: Houzz ${method} not sent`);
    }
    try {
      return await request({ method: 'GET', url, headers });
    } catch (e) {
      console.info(`Houzz ${method} failed: ${(e as Error).message}`);
      return false;
    }
  }
}
