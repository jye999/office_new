// Port of the old app's App\Libraries\AmazonApi (jlevers/selling-partner-api 5.10.2: LWA refresh-token auth +
// STS AssumeRole + SigV4, NA endpoint) for the SP-API calls that still have live callers:
//   getShippingRates / createShipment (MerchantFulfillmentV0), requestReport / getReportRequestList /
//   getReportDocument (ReportsV20210630, with a restricted data token for restricted report types),
//   getListing / patchListing (ListingsV20210801), uncompress, getPriorDays, getFormattedTimestamp.
// App\Libraries\Amazon (MWS + Product Advertising API) is dead and not ported; see plan/STATUS.md (L04).
//
// Every outbound HTTP call (LWA, STS, SP-API) goes through request(). Write calls (createShipment buys a
// label; patchListing edits the listing) are logged and NOT sent when DRY_RUN=1.
//
// Return shapes follow the PHP models' ArrayAccess keys: API JSON keys are converted to snake_case
// (`ShippingServiceId` -> `shipping_service_id`, `reportId` -> `report_id`). Listing `attributes` is free-form
// and keeps Amazon's own keys. Use camelizeModel()/pascalizeModel() if a controller must emit the PHP's
// json_encode(model) shape (model attributeMap names).

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface AmazonRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface AmazonResponse {
  status: number;
  body: string;
}
type Transport = (req: AmazonRequest) => Promise<AmazonResponse>;

// Host is derived from the URL by fetch; it stays in AmazonRequest.headers because the PHP signs and sends it.
const ALLOWED_HOSTS = new Set(['api.amazon.com', 'sellingpartnerapi-na.amazon.com', 'sts.us-east-1.amazonaws.com']);

const fetchTransport: Transport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.host)) throw new Error(`Amazon: refusing request to ${url.host}`);
  const { Host: _host, ...headers } = req.headers;
  const res = await fetch(url, { method: req.method, headers, body: req.body });
  return { status: res.status, body: await res.text() };
};

let transport: Transport = fetchTransport;

// Test seam so unit tests never reach Amazon. Also drops the cached tokens.
export function setAmazonTransportForTests(fn: Transport | null): void {
  transport = fn ?? fetchTransport;
  lwaCache = undefined;
  roleCache = undefined;
}

export async function request(req: AmazonRequest): Promise<AmazonResponse> {
  return transport(req);
}

// PHP ApiException: message "[code] body" for HTTP errors.
export class AmazonApiError extends Error {
  constructor(message: string, public status = 0, public responseBody = '') {
    super(message);
    this.name = 'AmazonApiError';
  }
}

export const WRITE_OPERATIONS = new Set(['createShipment', 'patchListingsItem']);

const HOST = 'sellingpartnerapi-na.amazon.com';
const REGION = 'us-east-1';
const USER_AGENT = 'jlevers/selling-partner-api/5.10.2 (Language=PHP)';
const SELLER_ID = 'ACSZZXVQ8ZU60';
const REFRESH_OFFSET_SECS = 30;

// ReportType::* constants with 'restricted' => true (need a restricted data token for getReportDocument).
const RESTRICTED_REPORT_TYPES = new Set([
  'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING', 'GET_ORDER_REPORT_DATA_INVOICING', 'GET_ORDER_REPORT_DATA_TAX',
  'GET_ORDER_REPORT_DATA_SHIPPING', 'GET_FLAT_FILE_ORDER_REPORT_DATA_INVOICING', 'GET_FLAT_FILE_ORDER_REPORT_DATA_SHIPPING',
  'GET_FLAT_FILE_ORDER_REPORT_DATA_TAX', 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_INVOICING',
  'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_TAX', 'SC_VAT_TAX_REPORT', 'GET_VAT_TRANSACTION_DATA', 'GET_GST_MTR_B2B_CUSTOM',
  'GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT', 'GET_XML_VAT_INVOICE_DATA_REPORT', 'GET_EASYSHIP_DOCUMENTS',
]);

// PHP: rawurlencode()
const rawurlencode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Guzzle Query::build (RFC 3986); null/undefined params are skipped like the `!== null` guards in the SDK.
function buildQuery(params: Record<string, string | number | null | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${rawurlencode(k)}=${rawurlencode(String(v))}`)
    .join('&');
}

// sanitizeForSerialization(): null model properties are not sent.
const dropNull = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

const toSnake = (k: string): string => k.replace(/[A-Z]/g, (c, i: number) => (i ? '_' : '') + c.toLowerCase());
const toCamel = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const toPascal = (k: string): string => toCamel(k).replace(/^[a-z]/, (c) => c.toUpperCase());

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

function mapKeys(v: Json, fn: (k: string) => string): Json {
  if (Array.isArray(v)) return v.map((x) => mapKeys(x, fn));
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [fn(k), k === 'attributes' ? x : mapKeys(x, fn)]),
  );
}

// API JSON -> the PHP model's property names. 'attributes' (listing) is a free-form object: kept as received.
export const snakeModel = (v: Json): any => mapKeys(v, toSnake);
// snake_case model -> camelCase API names (Reports/Listings JSON); Pascal for MerchantFulfillment.
export const camelizeModel = (v: Json): any => mapKeys(v, toCamel);
export const pascalizeModel = (v: Json): any => mapKeys(v, toPascal);

// ---- SigV4 (AuthorizationSigner.php) ----

interface AwsCreds {
  key: string;
  secret: string;
  token?: string;
  expires?: number;
}

const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');
const nowSecs = (): number => Math.floor(Date.now() / 1000);

// Signs exactly the headers present at call time (the PHP signer does the same, so x-amz-date and
// x-amz-access-token are added unsigned) and returns the request with Authorization + x-amz-date added.
export function signRequestV4(req: AmazonRequest, creds: AwsCreds, service: string): AmazonRequest {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = stamp.slice(0, 8);
  const rest = req.url.replace(/^https?:\/\/[^/?]+/, '');
  const qi = rest.indexOf('?');
  const path = qi < 0 ? rest : rest.slice(0, qi);
  const query = qi < 0 ? '' : rest.slice(qi + 1);

  // The path is already percent-encoded once; the signer encodes it a second time.
  const canonicalPath = `/${rawurlencode(path.replace(/^\/+/, '')).replace(/%2F/g, '/')}`;
  const canonicalQuery = query
    .split('&')
    .filter(Boolean)
    .map((p) => p.split('=') as [string, string?])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] ?? '') < (b[1] ?? '') ? -1 : 1))
    .map(([k, v]) => `${k}=${v ?? ''}`)
    .join('&');
  const headers = Object.entries(req.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headers.map(([k]) => k).join(';');
  const canonicalRequest = `${req.method}\n${canonicalPath}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${sha256(req.body ?? '')}`;
  const scope = `${date}/${REGION}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secret}`, date), REGION), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    ...req,
    headers: {
      ...req.headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': stamp,
    },
  };
}

// ---- Auth (Authentication.php) ----

const env = (name: string): string => (process.env[name] ?? '').trim();
const expiresSoon = (expires: number | undefined): boolean => expires !== undefined && nowSecs() >= expires - REFRESH_OFFSET_SECS;

let lwaCache: { token: string; expires: number } | undefined;
let roleCache: AwsCreds | undefined;

async function send(req: AmazonRequest): Promise<string> {
  const res = await request(req);
  if (res.status < 200 || res.status > 299) throw new AmazonApiError(`[${res.status}] ${res.body}`, res.status, res.body);
  return res.body;
}

async function lwaAccessToken(): Promise<string> {
  if (lwaCache && !expiresSoon(lwaCache.expires)) return lwaCache.token;
  const refreshToken = env('AMZ_LWA_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('lwaRefreshToken must be specified when calling non-grantless API operations');
  const body = JSON.parse(
    await send({
      method: 'POST',
      url: 'https://api.amazon.com/auth/o2/token',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: env('AMZ_LWA_CLIENT_ID'),
        client_secret: env('AMZ_LWA_CLIENT_SECRET'),
        refresh_token: refreshToken,
      }),
    }),
  );
  lwaCache = { token: body.access_token, expires: nowSecs() + Number(body.expires_in) };
  return lwaCache.token;
}

async function roleCredentials(): Promise<AwsCreds> {
  if (roleCache && !expiresSoon(roleCache.expires)) return roleCache;
  const query = buildQuery({
    Action: 'AssumeRole',
    RoleArn: env('AMZ_ROLE_ARN'),
    RoleSessionName: `spapi-assumerole-${nowSecs()}`,
    Version: '2011-06-15',
  });
  const unsigned: AmazonRequest = {
    method: 'POST',
    url: `https://sts.${REGION}.amazonaws.com?${query}`,
    headers: { Accept: 'application/json', Host: `sts.${REGION}.amazonaws.com` },
  };
  const signed = signRequestV4(unsigned, { key: env('AMZ_ACCESS_KEY_ID'), secret: env('AMZ_ACCESS_SECRET') }, 'sts');
  signed.headers['x-amz-access-token'] = await lwaAccessToken();
  const c = JSON.parse(await send(signed)).AssumeRoleResponse.AssumeRoleResult.Credentials;
  roleCache = { key: c.AccessKeyId, secret: c.SecretAccessKey, token: c.SessionToken, expires: Number(c.Expiration) };
  return roleCache;
}

// Signs an SP-API request: x-amz-access-token = LWA token (or the RDT), signature from the assumed-role creds
// (or the plain AWS key when AMZ_ROLE_ARN is unset).
async function signSpApi(req: AmazonRequest, accessToken: string): Promise<AmazonRequest> {
  const roleArn = env('AMZ_ROLE_ARN');
  const creds: AwsCreds = roleArn ? await roleCredentials() : { key: env('AMZ_ACCESS_KEY_ID'), secret: env('AMZ_ACCESS_SECRET') };
  const signed = signRequestV4(req, creds, 'execute-api');
  signed.headers['x-amz-access-token'] = accessToken;
  if (roleArn) signed.headers['x-amz-security-token'] = creds.token!;
  return signed;
}

interface SpApiCall {
  operation: string;
  method: string;
  path: string;
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
  restrictedDataToken?: boolean;
}

// One SP-API operation: returns the parsed JSON (raw API keys). Throws AmazonApiError on non-2xx.
async function spApi(call: SpApiCall): Promise<any> {
  if (WRITE_OPERATIONS.has(call.operation) && process.env.DRY_RUN === '1') {
    console.info(`[DRY_RUN] Amazon SP-API ${call.operation} not sent`, JSON.stringify(call.body));
    throw new AmazonApiError(`DRY_RUN: Amazon ${call.operation} not sent`);
  }
  const query = call.query ? buildQuery(call.query) : '';
  const req: AmazonRequest = {
    method: call.method,
    url: `https://${HOST}${call.path}${query ? `?${query}` : ''}`,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json', Host: HOST },
  };
  if (call.body !== undefined) req.body = JSON.stringify(call.body);
  const accessToken = call.restrictedDataToken ? await restrictedDataToken(call.path, call.method) : await lwaAccessToken();
  return JSON.parse(await send(await signSpApi(req, accessToken)));
}

// Authentication::getRestrictedDataToken(): POST /tokens/2021-03-01/restrictedDataToken.
async function restrictedDataToken(path: string, method: string): Promise<string> {
  const res = await spApi({
    operation: 'createRestrictedDataToken',
    method: 'POST',
    path: '/tokens/2021-03-01/restrictedDataToken',
    body: { restrictedResources: [{ method, path }] },
  }).catch((e: unknown) => {
    if (e instanceof AmazonApiError) throw new Error(`Failed to create restricted data token: ${e.message}`);
    throw e;
  });
  return res.restrictedDataToken;
}

// ---- AmazonApi.php ----

const NA_MARKETPLACES = ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8'];

// Hardcoded in the PHP constructor. Its 'phone_number' key is not a model property (the model's is 'phone'),
// so the PHP never sent a Phone.
const FROM_ADDRESS = {
  Name: 'Angel Isabella, LLC',
  AddressLine1: '1550 oak industrial ln',
  AddressLine2: 'Ste F',
  Email: 'contact@angelisabella.com',
  City: 'Cumming',
  StateOrProvinceCode: 'GA',
  PostalCode: '30041',
  CountryCode: 'US',
};

export interface ItemToShip {
  itemId: unknown;
  qty: unknown;
}

export const getPriorDays = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'); // shortcut: no DST wall-clock arithmetic like strtotime('-N day')

export const getFormattedTimestamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function shipmentRequestDetails(
  orderId: string, length: unknown, width: unknown, height: unknown, weightInOz: unknown, itemsToShip: ItemToShip[],
  deliveryExperience: string, extra: Record<string, unknown> = {},
) {
  return dropNull({
    AmazonOrderId: orderId,
    ItemList: itemsToShip.map((i) => dropNull({ OrderItemId: i.itemId, Quantity: i.qty })),
    ShipFromAddress: FROM_ADDRESS,
    PackageDimensions: dropNull({ Length: length, Width: width, Height: height, Unit: 'inches' }),
    Weight: dropNull({ Value: weightInOz, Unit: 'oz' }),
    ...extra,
    ShippingServiceOptions: { DeliveryExperience: deliveryExperience, LabelFormat: 'PNG' },
  });
}

export class AmazonApi {
  getPriorDays = getPriorDays;
  getFormattedTimestamp = getFormattedTimestamp;

  // Returns the services that have a rate: first the DeliveryConfirmationWithoutSignature query, then the
  // NoTracking query adding services whose name is not already listed. Errors propagate (the PHP's
  // `catch (Exception $e)` resolves to a non-existent App\Libraries\Exception, so it never caught anything).
  async getShippingRates(
    orderId: string, length: unknown, width: unknown, height: unknown, weightInOz: unknown, itemsToShip: ItemToShip[],
    shipDate: string | null = null, mustArriveByDate: string | null = null,
  ): Promise<any[]> {
    const listWithRates: any[] = [];
    const dates = { MustArriveByDate: mustArriveByDate, ShipDate: shipDate };
    for (const deliveryExperience of ['DeliveryConfirmationWithoutSignature', 'NoTracking']) {
      const result = snakeModel(
        await spApi({
          operation: 'getEligibleShipmentServices',
          method: 'POST',
          path: '/mfn/v0/eligibleShippingServices',
          body: {
            ShipmentRequestDetails: shipmentRequestDetails(
              orderId, length, width, height, weightInOz, itemsToShip, deliveryExperience, dates,
            ),
          },
        }),
      );
      for (const s of result.payload?.shipping_service_list ?? []) {
        if (s.rate === undefined || s.rate === null) continue;
        if (deliveryExperience === 'NoTracking' && listWithRates.some((l) => l.shipping_service_name == s.shipping_service_name)) continue;
        listWithRates.push(s);
      }
    }
    return listWithRates;
  }

  // WRITE (buys the label). Returns the response `payload` (the Shipment model).
  async createShipment(
    orderId: string, length: unknown, width: unknown, height: unknown, weightInOz: unknown, itemsToShip: ItemToShip[],
    shippingServiceId: string, shippingServiceOfferId: string | null = null,
  ): Promise<any> {
    const deliveryExperience = shippingServiceId == 'UPS_PTP_GROUNDSAVER' ? 'NoTracking' : 'DeliveryConfirmationWithoutSignature';
    const result = await spApi({
      operation: 'createShipment',
      method: 'POST',
      path: '/mfn/v0/shipments',
      body: dropNull({
        ShipmentRequestDetails: shipmentRequestDetails(orderId, length, width, height, weightInOz, itemsToShip, deliveryExperience),
        ShippingServiceId: shippingServiceId,
        ShippingServiceOfferId: shippingServiceOfferId,
      }),
    });
    return snakeModel(result).payload;
  }

  // gzopen() reads plain files transparently too, so a non-gzip source is copied as is.
  uncompress(srcName: string, dstName: string): void {
    const src = readFileSync(srcName);
    writeFileSync(dstName, src[0] === 0x1f && src[1] === 0x8b ? gunzipSync(src) : src);
  }

  // Creates a report request (not a marketplace write). Returns {report_id}.
  async requestReport(
    reportType = 'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING', startDate: string | null = null, endDate: string | null = null,
  ): Promise<any> {
    return snakeModel(
      await spApi({
        operation: 'createReport',
        method: 'POST',
        path: '/reports/2021-06-30/reports',
        body: {
          reportType,
          dataStartTime: startDate ?? getPriorDays(89),
          dataEndTime: endDate ?? getFormattedTimestamp(),
          marketplaceIds: NA_MARKETPLACES,
        },
      }),
    );
  }

  // $MaxCount is unused in the PHP too (pageSize is fixed at 10). Returns {reports: [...], next_token?}.
  async getReportRequestList(reportType = 'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING', status = 'DONE', _maxCount = '1'): Promise<any> {
    return snakeModel(
      await spApi({
        operation: 'getReports',
        method: 'GET',
        path: '/reports/2021-06-30/reports',
        query: { reportTypes: reportType, processingStatuses: status, pageSize: 10, createdSince: getPriorDays(7) },
      }),
    );
  }

  // Returns {report_document_id, url, compression_algorithm?}.
  async getReportDocument(reportDocumentId: string, reportType: string): Promise<any> {
    return snakeModel(
      await spApi({
        operation: 'getReportDocument',
        method: 'GET',
        path: `/reports/2021-06-30/documents/${rawurlencode(reportDocumentId)}`,
        restrictedDataToken: RESTRICTED_REPORT_TYPES.has(reportType),
      }),
    );
  }

  // Returns the Item model ({sku, summaries, attributes, ...}) or throws.
  async getListing(sku: string): Promise<any> {
    return snakeModel(
      await spApi({
        operation: 'getListingsItem',
        method: 'GET',
        path: `/listings/2021-08-01/items/${SELLER_ID}/${rawurlencode(sku)}`,
        query: { marketplaceIds: 'ATVPDKIKX0DER', issueLocale: 'en_US', includedData: 'summaries,attributes,procurement' },
      }),
    );
  }

  // WRITE (edits the live listing). bulletPoints is sent as is: [{value: '...'}].
  async patchListing(sku: string, productType: string, itemName: string, description: string, bulletPoints: unknown[]): Promise<any> {
    return snakeModel(
      await spApi({
        operation: 'patchListingsItem',
        method: 'PATCH',
        path: `/listings/2021-08-01/items/${SELLER_ID}/${rawurlencode(sku)}`,
        query: { marketplaceIds: 'ATVPDKIKX0DER,A1AM78C64UM0Y8,A2EUQ1WTGCTBG2', issueLocale: 'en_US' },
        body: {
          productType,
          patches: [
            { op: 'replace', path: '/attributes/product_description', value: [{ value: description }] },
            { op: 'replace', path: '/attributes/item_name', value: [{ value: itemName }] },
            { op: 'replace', path: '/attributes/bullet_point', value: bulletPoints },
          ],
        },
      }),
    );
  }
}
