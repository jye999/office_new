// Port of the old app's App\Libraries\eBayApi (eBay REST APIs with an OAuth refresh-token flow).
// Ported: refreshToken (called lazily by every request), GetUnshippedOrders, GetItemByLegacyId, GetItemById,
// UploadShipping (the only methods EbayApiHelper calls). Skipped: getTokenFromCode (its only caller,
// EbayController@ebayAccept, has it commented out), the unused private urlencode/getParametersAsString.
// The PHP Log::info noise and the print_r() debug echoes are not reproduced.
//
// Every outbound call goes through request(). UploadShipping (POST shipping_fulfillment: uploads
// tracking to the marketplace) is logged and NOT sent when DRY_RUN=1.

import { date, json_encode } from '../view.js';

export class EbayApiError extends Error {}

export interface EbayApiRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type EbayApiTransport = (req: EbayApiRequest) => Promise<string>;

// curl_exec(): the reply text, or false (-> '') when the connection failed.
const fetchTransport: EbayApiTransport = async (req) => {
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'https:' || !(url.hostname === 'ebay.com' || url.hostname.endsWith('.ebay.com'))) return '';
    const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body });
    return await res.text();
  } catch {
    return '';
  }
};

let transport: EbayApiTransport = fetchTransport;

// Test seam so unit tests never call api.ebay.com.
export function setEbayApiTransportForTests(fn: EbayApiTransport | null): void {
  transport = fn ?? fetchTransport;
}

// The single outbound seam for the REST API.
export function request(req: EbayApiRequest): Promise<string> {
  return transport(req);
}

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
].join(' ');

// json_decode($response, true): null when the reply is not JSON (or the JSON null).
function jsonDecode(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const WRITE_PATHS = /\/shipping_fulfillment$/;

export class EbayApi {
  private ebayAppName = 'ebay';
  private authToken = '';

  constructor(ebayAppName = 'ebay') {
    if (ebayAppName !== '') this.ebayAppName = ebayAppName;
  }

  // config('app.<ebayAppName>.<key>'): 'ebay' -> EBAY_*, 'raystore' -> RAYSTORE_*. Only 'ebay' has an API url
  // and OAuth refresh token under its own name (EBAY_API_URL / EBAY_OAUTH_REFRESH_TOKEN); raystore's refresh
  // token is RAYSTORE_REFRESHTOKEN and it has no `api` url at all (PHP: null).
  private config(key: 'appID' | 'certID' | 'refreshToken' | 'api'): string {
    const prefix = this.ebayAppName.toUpperCase();
    const names = {
      appID: `${prefix}_APPID`,
      certID: `${prefix}_CERTID`,
      refreshToken: this.ebayAppName === 'ebay' ? 'EBAY_OAUTH_REFRESH_TOKEN' : `${prefix}_REFRESHTOKEN`,
      api: `${prefix}_API_URL`,
    };
    return process.env[names[key]] ?? '';
  }

  private get codeAuth(): string {
    return Buffer.from(`${this.config('appID')}:${this.config('certID')}`).toString('base64');
  }

  async refreshToken(): Promise<void> {
    const response = await request({
      method: 'POST',
      url: `${this.config('api')}/identity/v1/oauth2/token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${this.codeAuth}` },
      // Not URL-encoded, exactly as the PHP posts it.
      body: `grant_type=refresh_token&refresh_token=${this.config('refreshToken')}&scope=${SCOPES}`,
    });
    const json = jsonDecode(response);
    if (json !== null && typeof json === 'object' && json.access_token !== undefined && json.access_token !== null) {
      this.authToken = json.access_token;
    } else {
      throw new EbayApiError(`failed to get ebay access token${json_encode(json)}`);
    }
  }

  private async sendRequest(url: string, method: 'GET' | 'POST', postData = ''): Promise<any> {
    if (method === 'POST' && WRITE_PATHS.test(url) && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] eBay REST POST ${url} not sent`, postData);
      throw new EbayApiError(`DRY_RUN: eBay POST ${url} not sent`);
    }
    if (this.authToken === '') await this.refreshToken();
    const response = await request({
      method,
      url: this.config('api') + url,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.authToken}` },
      ...(method === 'POST' ? { body: postData } : {}),
    });
    return jsonDecode(response);
  }

  GetUnshippedOrders(): Promise<any> {
    return this.sendRequest('/sell/fulfillment/v1/order?filter=orderfulfillmentstatus:%7BNOT_STARTED%7CIN_PROGRESS%7D&limit=100&offset=0', 'GET');
  }

  GetItemByLegacyId(itemId: unknown, varId: unknown): Promise<any> {
    let url = `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`;
    if (varId !== '' && varId !== null && varId !== undefined) url += `&legacy_variation_id=${varId}`;
    return this.sendRequest(url, 'GET');
  }

  // $varId is accepted and ignored, like the PHP.
  GetItemById(itemId: unknown, _varId: unknown): Promise<any> {
    return this.sendRequest(`/buy/browse/v1/item/${itemId}`, 'GET');
  }

  UploadShipping(orderId: unknown, items: unknown, trackingNumber: string): Promise<any> {
    const carrier = trackingNumber.startsWith('Z') ? 'USP' : trackingNumber.length > 12 ? 'USPS' : 'FedEx';
    const shipdate = date('Y-m-d\\TH:i:s');
    const dataToPost = `{
        "lineItems": ${json_encode(items)},
        "shippedDate": "${shipdate}.000Z",
        "shippingCarrierCode": "${carrier}",
        "trackingNumber": "${trackingNumber}"
    }`;
    return this.sendRequest(`/sell/fulfillment/v1/order/${orderId}/shipping_fulfillment`, 'POST', dataToPost);
  }
}
