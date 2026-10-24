// Port of the old app's App\Libraries\EtsyClient plus the two OAuth stacks it and EtsyController use:
//  - OAuth1 "Etsy" service of lusitanian/oauth (HMAC-SHA1, StreamClient): what EtsyClient really runs on. Tokens are NOT
//    persisted anywhere: the access token/secret come from env (config('app.etsy<store>.token|secret'), ETSY_TOKEN<n>/
//    ETSY_SECRET<n>) and are put into an in-memory (PHP: $_SESSION) store on every setupRequest().
//  - OAuth2 startz/oauth2-etsy provider (PKCE) used by EtsyController@sendAuthRequest/callback. The old app persists the
//    resulting tokens in the `integration` DB table `etsy_integration` (model EtsyIntegration); that write belongs to the
//    callback route (T42), this file only does the HTTP/URL part.
// Ported EtsyClient methods (the ones with callers): getOrders, getCountries, getAllListing, getCategories, getListingById,
// getTransaction, postTracking. Skipped (no caller, or dead/broken PHP): GetScope, GetTransFromReceipt, GetListing,
// GetInventory, GetReceipts, objectToObject, getTokenRequest, getAccessToken (OAuth1 token flow is in EtsyOAuth1).
//
// Every outbound call goes through request(). postTracking (uploads tracking to Etsy) is logged and NOT sent when DRY_RUN=1.

import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

export class EtsyError extends Error {}

export interface EtsyRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EtsyResponse {
  status: number;
  reason: string;
  body: string;
}

type EtsyTransport = (req: EtsyRequest) => Promise<EtsyResponse>;

const ALLOWED_HOSTS = ['openapi.etsy.com', 'flow.angelisabella.com'];

const fetchTransport: EtsyTransport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) {
    throw new EtsyError(`Etsy: host not allowed: ${url.hostname}`);
  }
  const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, reason: res.statusText, body: await res.text() };
};

let transport: EtsyTransport = fetchTransport;

// Test seam so unit tests never call etsy.com.
export function setEtsyTransportForTests(fn: EtsyTransport | null): void {
  transport = fn ?? fetchTransport;
}

// The single outbound seam.
export function request(req: EtsyRequest): Promise<EtsyResponse> {
  return transport(req);
}

// Etsy write calls: POST .../receipts/<id>/tracking.
export const WRITE_URLS = /\/receipts\/[^/?]+\/tracking$/;

// ---- PHP helpers -------------------------------------------------------------------------------------------------

export function rawurlencode(v: unknown): string {
  return encodeURIComponent(v === null || v === undefined ? '' : String(v)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// urlencode(): like rawurlencode but space -> '+' and '~' -> %7E.
function urlencode(v: unknown): string {
  return rawurlencode(v).replace(/%20/g, '+').replace(/~/g, '%7E');
}

// http_build_query($params) (RFC1738, null entries skipped), or RFC3986 when rfc3986 is set.
export function httpBuildQuery(params: Record<string, unknown>, rfc3986 = false): string {
  const enc = rfc3986 ? rawurlencode : urlencode;
  return Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${enc(k)}=${enc(v === true ? 1 : v === false ? 0 : v)}`)
    .join('&');
}

// parse_str() for flat query strings (key '.' and ' ' become '_', like PHP).
export function parseStr(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split('&')) {
    if (part === '') continue;
    const i = part.indexOf('=');
    const dec = (x: string) => decodeURIComponent(x.replace(/\+/g, ' '));
    const k = dec(i < 0 ? part : part.slice(0, i)).replace(/[. ]/g, '_');
    out[k] = i < 0 ? '' : dec(part.slice(i + 1));
  }
  return out;
}

// json_decode($s, true): null when not JSON.
function jsonDecode(text: string | null | undefined): any {
  try {
    return JSON.parse(text as string);
  } catch {
    return null;
  }
}

// isset($a['results']) && sizeof($a['results']) > 0
function nonEmptyResults(a: any): boolean {
  return a !== null && typeof a === 'object' && a.results != null && Object.keys(a.results).length > 0;
}

// EtsyClient strips every "\r\n"-separated line of 10 bytes or less before json_decode.
function joinLongLines(s: string): string {
  return s
    .split('\r\n')
    .filter((el) => Buffer.byteLength(el) > 10)
    .join('');
}

// ---- OAuth1 (lusitanian/oauth Etsy service) --------------------------------------------------------------------

export interface EtsyOAuth1Token {
  accessToken: string;
  accessTokenSecret: string;
  requestTokenSecret?: string;
  extraParams?: Record<string, string>;
}

export interface EtsyOAuth1Options {
  now?: () => number;
  nonce?: () => string;
}

const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
const BASE_API_URI = 'https://openapi.etsy.com/v2/';

export class EtsyOAuth1 {
  private token: EtsyOAuth1Token | null = null;

  constructor(
    private consumerKey: string,
    private consumerSecret: string,
    private options: EtsyOAuth1Options = {},
  ) {}

  storeAccessToken(token: EtsyOAuth1Token): void {
    this.token = token;
  }

  retrieveAccessToken(): EtsyOAuth1Token {
    if (!this.token) throw new EtsyError('Token not found in session, are you sure you stored it?');
    return this.token;
  }

  private nonce(): string {
    if (this.options.nonce) return this.options.nonce();
    let n = '';
    for (let i = 0; i < 32; i++) n += NONCE_CHARS[randomInt(NONCE_CHARS.length)];
    return n;
  }

  // getBasicAuthorizationHeaderInfo(); oauth_callback is always null (Credentials callback) -> sent as an empty value.
  private basicParameters(): Record<string, string | null> {
    return {
      oauth_callback: null,
      oauth_consumer_key: this.consumerKey,
      oauth_nonce: this.nonce(),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(this.options.now ? this.options.now() : Math.floor(Date.now() / 1000)),
      oauth_version: '1.0',
    };
  }

  // OAuth\OAuth1\Signature\Signature::getSignature
  private signature(url: URL, params: Record<string, string | null>, method: string, tokenSecret: string | null): string {
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...parseStr(url.search.slice(1)), ...params })) data[rawurlencode(k)] = rawurlencode(v);
    const dataString = Object.keys(data)
      .sort()
      .map((k) => `${k}=${data[k]}`)
      .join('&');
    const baseUri = `${url.protocol}//${url.host}${url.pathname === '/' && !url.href.slice(url.origin.length).startsWith('/') ? '' : url.pathname}`;
    const base = `${method.toUpperCase()}&${rawurlencode(baseUri)}&${rawurlencode(dataString)}`;
    const key = `${rawurlencode(this.consumerSecret)}&${tokenSecret !== null ? rawurlencode(tokenSecret) : ''}`;
    return createHmac('sha1', key).update(base).digest('base64');
  }

  private header(params: Record<string, string | null>): string {
    return 'OAuth ' + Object.entries(params).map(([k, v]) => `${rawurlencode(k)}="${rawurlencode(v)}"`).join(', ');
  }

  // buildAuthorizationHeaderForAPIRequest
  private apiAuthorizationHeader(method: string, url: URL, token: EtsyOAuth1Token, bodyParams: Record<string, string> | null): string {
    // PHP: isset(null callback) is false, so oauth_callback="" stays in the header and the signature.
    const auth: Record<string, string | null> = this.basicParameters();
    auth.oauth_token = token.accessToken;
    auth.oauth_signature = this.signature(url, bodyParams ? { ...auth, ...bodyParams } : auth, method, token.accessTokenSecret);
    return this.header(auth);
  }

  // Etsy::__construct baseApiUri + AbstractService::determineRequestUriFromPath
  private uriFromPath(path: string): URL {
    if (/^https?:\/\//i.test(path)) return new URL(path);
    const uri = new URL(BASE_API_URI);
    let p = path;
    const q = p.indexOf('?');
    if (q >= 0) {
      uri.search = p.slice(q + 1);
      p = p.slice(0, q);
    }
    if (p[0] === '/') p = p.slice(1);
    uri.pathname = uri.pathname + p;
    return uri;
  }

  // StreamClient::retrieveResponse: non-2xx -> TokenResponseException with the file_get_contents() warning text.
  private async send(url: URL, body: Record<string, string> | null, headers: Record<string, string>, method: 'GET' | 'POST'): Promise<string> {
    const hasBody = body !== null && Object.keys(body).length > 0;
    if (method === 'GET' && hasBody) throw new EtsyError('No body expected for "GET" request.');
    const sendHeaders: Record<string, string> = { ...headers, 'User-Agent': 'PHPoAuthLib' };
    if (method === 'POST' && body !== null && !('Content-Type' in sendHeaders)) {
      sendHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await request({ method, url: url.href, headers: sendHeaders, body: method === 'POST' ? httpBuildQuery(body ?? {}) : undefined });
    if (res.status < 200 || res.status >= 300) {
      throw new EtsyError(`file_get_contents(${url.href}): failed to open stream: HTTP request failed! HTTP/1.1 ${res.status} ${res.reason}\r\n`);
    }
    return res.body;
  }

  // AbstractService::request
  async request(path: string, method: 'GET' | 'POST' = 'GET', body: Record<string, string> | null = null): Promise<string> {
    const url = this.uriFromPath(path);
    if (method !== 'GET' && WRITE_URLS.test(url.pathname) && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] Etsy ${method} ${url.href} not sent`, JSON.stringify(body));
      throw new EtsyError(`DRY_RUN: Etsy ${method} ${url.href} not sent`);
    }
    const token = this.retrieveAccessToken();
    return this.send(url, body, { Authorization: this.apiAuthorizationHeader(method, url, token, body) }, method);
  }

  private parseTokenResponse(responseBody: string, requireCallbackConfirmed: boolean): EtsyOAuth1Token {
    const data = parseStr(responseBody);
    if (requireCallbackConfirmed && data.oauth_callback_confirmed !== 'true') throw new EtsyError('Error in retrieving token.');
    if (data.error !== undefined) throw new EtsyError(`Error in retrieving token: "${data.error}"`);
    const { oauth_token, oauth_token_secret, ...extraParams } = data;
    return { accessToken: oauth_token, accessTokenSecret: oauth_token_secret, requestTokenSecret: oauth_token_secret, extraParams };
  }

  // AbstractService::requestRequestToken (EtsyController getTokenRequest*, Runner GetEtsyToken)
  async requestRequestToken(): Promise<EtsyOAuth1Token> {
    const url = new URL(`${BASE_API_URI}oauth/request_token`);
    const params = this.basicParameters();
    params.oauth_signature = this.signature(url, params, 'POST', null);
    const responseBody = await this.send(url, {}, { Authorization: this.header(params) }, 'POST');
    const token = this.parseTokenResponse(responseBody, true);
    this.storeAccessToken(token);
    return token;
  }

  // AbstractService::requestAccessToken. As in the PHP, the signing token is the stored one; the $token argument is unused.
  async requestAccessToken(_token: string, verifier: string, tokenSecret: string | null = null): Promise<EtsyOAuth1Token> {
    const secret = tokenSecret ?? this.retrieveAccessToken().requestTokenSecret ?? null;
    const url = new URL(`${BASE_API_URI}oauth/access_token`);
    const bodyParams = { oauth_verifier: verifier };
    const stored = this.retrieveAccessToken();
    const header = this.apiAuthorizationHeader('POST', url, { ...stored, accessTokenSecret: secret ?? '' }, bodyParams);
    const responseBody = await this.send(url, bodyParams, { Authorization: header }, 'POST');
    const token = this.parseTokenResponse(responseBody, false);
    this.storeAccessToken(token);
    return token;
  }
}

// ---- EtsyClient ------------------------------------------------------------------------------------------------

export class EtsyClient {
  private etsyService: EtsyOAuth1 | null = null;

  constructor(
    private store = 1,
    private options: EtsyOAuth1Options = {},
  ) {}

  // config('app.etsy<store>.<key>')
  private config(key: 'CONSUMER_KEY' | 'CONSUMER_SECRET' | 'TOKEN' | 'SECRET'): string {
    return process.env[`ETSY_${key}${this.store}`] ?? '';
  }

  setupRequest(): EtsyOAuth1 {
    if (this.etsyService) return this.etsyService;
    const service = new EtsyOAuth1(this.config('CONSUMER_KEY'), this.config('CONSUMER_SECRET'), this.options);
    service.storeAccessToken({ accessToken: this.config('TOKEN'), accessTokenSecret: this.config('SECRET') });
    this.etsyService = service;
    return service;
  }

  async getOrders(offset: number | string = 1): Promise<any[] | null> {
    const etsyService = this.setupRequest();
    const serviceResults = await etsyService.request(
      `https://openapi.etsy.com/v3/application/shops/__SELF__/receipts?limit=100&offset=${offset}&was_paid=true&was_shipped=false`,
    );
    const results = jsonDecode(joinLongLines(serviceResults));
    if (results !== null && typeof results === 'object' && results.results != null) return results.results;
    return null;
  }

  // Map of country_id -> iso_country_code
  async getCountries(): Promise<Record<string, string>> {
    const etsyService = this.setupRequest();
    const countryResults = jsonDecode(joinLongLines(await etsyService.request('/countries')));
    const countries: Record<string, string> = {};
    if (nonEmptyResults(countryResults)) {
      for (const c of Object.values<any>(countryResults.results)) countries[c.country_id] = c.iso_country_code;
    }
    return countries;
  }

  // PHP: json_decode(...) of the reply (array or null)
  async getAllListing(page: number | string = 1): Promise<any> {
    const etsyService = this.setupRequest();
    return jsonDecode(
      await etsyService.request(`https://openapi.etsy.com/v3/application/shops/__SELF__/listings/active?limit=100&page=${page}&includes=Images,MainImage`),
    );
  }

  async getCategories(): Promise<any> {
    const etsyService = this.setupRequest();
    return jsonDecode(await etsyService.request('https://openapi.etsy.com/v3/application/shops/__SELF__/sections'));
  }

  // Not an Etsy call: GET on the angelisabella n8n webhook (curl: a failed connection gives false -> json_decode -> null).
  async getListingById(listingId: number | string): Promise<any> {
    const store = this.store !== 1 ? `T${this.store}` : 'T';
    const url = `https://flow.angelisabella.com/webhook/15dea4d4-d58f-4d34-a13b-3bc04b9eb337/15dea4d4-d58f-4d34-a13b-3bc04b9eb337/${store}/${listingId}`;
    try {
      const res = await request({ method: 'GET', url, headers: {} });
      return jsonDecode(res.body);
    } catch {
      return null;
    }
  }

  async getTransaction(transactionId: number | string): Promise<any[]> {
    const etsyService = this.setupRequest();
    const results = jsonDecode(await etsyService.request(`https://openapi.etsy.com/v3/application/transactions/${transactionId}?limit=100`));
    if (nonEmptyResults(results)) {
      // PHP quirk: the loop body calls $oauth->fetch() on an undefined $oauth -> fatal Error (not an OAuthException).
      throw new EtsyError('Call to a member function fetch() on null');
    }
    return [];
  }

  async postTracking(receiptId: number | string, tracking: string): Promise<void> {
    const trackingText = String(tracking);
    let carrier: string;
    if (trackingText.slice(0, 2) === '1Z') carrier = 'USP';
    else if (Buffer.byteLength(trackingText) > 12) carrier = 'USPS';
    else carrier = 'Fedex';
    const etsyService = this.setupRequest();
    await etsyService.request(`https://openapi.etsy.com/v3/application/shops/__SELF__/receipts/${receiptId}/tracking`, 'POST', {
      tracking_code: trackingText,
      carrier_name: carrier,
    });
  }
}

// ---- OAuth2 (startz/oauth2-etsy provider) ---------------------------------------------------------------------

export class EtsyIdentityProviderError extends Error {
  constructor(
    message: string,
    public code: number,
    public responseBody: string,
  ) {
    super(message);
  }
}

export interface EtsyAccessToken {
  accessToken: string;
  refreshToken?: string;
  expires?: number;
  resourceOwnerId?: string;
  values: Record<string, unknown>;
}

// Free-form like the PHP options array; known keys typed.
interface EtsyAuthorizationOptions {
  state?: string;
  scope?: string | string[];
  redirect_uri?: string;
  [param: string]: string | string[] | undefined;
}

interface EtsyTokenOptions {
  code: string;
  code_verifier?: string;
}

const OAUTH2_BASE_API_URL = 'https://openapi.etsy.com/v3';

export class EtsyOAuth2Provider {
  private state: string | null = null;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(opts: { clientId: string; clientSecret: string; redirectUri: string }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
  }

  getState(): string | null {
    return this.state;
  }

  getPreChallenge(): string {
    return randomBytes(64).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').slice(0, 64);
  }

  getPKCE(preChallenge: string): string {
    return createHash('sha256').update(preChallenge).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/^=+|=+$/g, '');
  }

  // AbstractProvider::getAuthorizationUrl with the Etsy defaults (scope separator ' ', default scope email_r).
  getAuthorizationUrl(options: EtsyAuthorizationOptions = {}): string {
    const o: EtsyAuthorizationOptions = { ...options };
    if (!o.state) o.state = randomBytes(16).toString('hex');
    if (!o.scope || (Array.isArray(o.scope) && o.scope.length === 0)) o.scope = ['email_r'];
    if (o.response_type === undefined) o.response_type = 'code';
    if (o.approval_prompt === undefined) o.approval_prompt = 'auto';
    if (Array.isArray(o.scope)) o.scope = o.scope.join(' ');
    this.state = o.state as string;
    if (o.redirect_uri === undefined) o.redirect_uri = this.redirectUri;
    o.client_id = this.clientId;
    return `https://www.etsy.com/oauth/connect?${httpBuildQuery(o, true)}`;
  }

  // getAccessToken('authorization_code', {code, code_verifier}); the params are sent both in the URL query and the body.
  async getAccessToken(grant: 'authorization_code', options: EtsyTokenOptions): Promise<EtsyAccessToken> {
    if (options.code === undefined) throw new Error('Required parameter not passed: "code"');
    const params = { client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: grant, ...options };
    const qs = httpBuildQuery(params, true);
    const res = await request({
      method: 'POST',
      url: `${OAUTH2_BASE_API_URL}/public/oauth/token?${qs}`,
      headers: { 'x-api-key': this.clientId, 'content-type': 'application/x-www-form-urlencoded' },
      body: qs,
    });
    const data = this.checkedJson(res);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid response received from Authorization Server. Expected JSON.');
    }
    if (!data.access_token) throw new Error('Required option not passed: "access_token"');
    const token: EtsyAccessToken = { accessToken: data.access_token, values: data };
    if (data.refresh_token) token.refreshToken = data.refresh_token;
    if (data.expires_in !== undefined && data.expires_in !== null) {
      token.expires = Number(data.expires_in) !== 0 ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : 0;
    }
    return token;
  }

  // getResourceOwner: GET /application/users/<user id = access token prefix>; returns the decoded user.
  async getResourceOwner(token: EtsyAccessToken): Promise<any> {
    const res = await request({
      method: 'GET',
      url: `${OAUTH2_BASE_API_URL}/application/users/${token.accessToken.split('.')[0]}`,
      headers: { 'x-api-key': this.clientId, Authorization: `Bearer ${token.accessToken}` },
    });
    return this.checkedJson(res);
  }

  // EtsyIdentityProviderException on status >= 400 (message or reason phrase) or an `error` key.
  private checkedJson(res: EtsyResponse): any {
    const data = jsonDecode(res.body);
    if (res.status >= 400) throw new EtsyIdentityProviderError(data?.message ?? res.reason, res.status, res.body);
    if (data !== null && typeof data === 'object' && data.error) throw new EtsyIdentityProviderError(data.error, res.status, res.body);
    return data;
  }
}
