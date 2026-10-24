// L04: App\Libraries\AmazonApi port. Nothing reaches Amazon: every call goes through setAmazonTransportForTests.
// The two SigV4 signatures are golden values produced by the old app's vendor AuthorizationSigner (run in the
// `office` docker container with a fixed request time and fake credentials).

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AmazonApi, AmazonApiError, camelizeModel, getFormattedTimestamp, getPriorDays, pascalizeModel, setAmazonTransportForTests,
  signRequestV4, type AmazonRequest,
} from '../src/lib/amazonApi.js';

const NOW = new Date('2026-01-02T03:04:05Z');
let calls: AmazonRequest[];
let replies: Record<string, (req: AmazonRequest) => { status?: number; body: unknown }>;

const spCalls = () => calls.filter((c) => c.url.includes('sellingpartnerapi-na'));
const url = (c: AmazonRequest) => new URL(c.url);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.assign(process.env, {
    AMZ_LWA_CLIENT_ID: 'cid',
    AMZ_LWA_CLIENT_SECRET: 'csecret',
    AMZ_LWA_REFRESH_TOKEN: 'rtoken',
    AMZ_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AMZ_ACCESS_SECRET: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    AMZ_ROLE_ARN: 'arn:aws:iam::1:role/SpApiRole',
  });
  delete process.env.DRY_RUN;
  calls = [];
  replies = {};
  setAmazonTransportForTests(async (req) => {
    calls.push(req);
    const u = new URL(req.url);
    let key = `${req.method} ${u.host}${u.pathname}`;
    if (u.host === 'api.amazon.com') return { status: 200, body: JSON.stringify({ access_token: 'LWA', expires_in: 3600 }) };
    if (u.host.startsWith('sts.')) {
      return {
        status: 200,
        body: JSON.stringify({
          AssumeRoleResponse: {
            AssumeRoleResult: { Credentials: { AccessKeyId: 'RK', SecretAccessKey: 'RS', SessionToken: 'RT', Expiration: Math.floor(Date.now() / 1000) + 3600 } },
          },
        }),
      };
    }
    if (u.pathname === '/tokens/2021-03-01/restrictedDataToken') return { status: 200, body: JSON.stringify({ restrictedDataToken: 'RDT', expiresIn: 3600 }) };
    const reply = replies[key] ?? replies[`${req.method} ${u.pathname}`];
    if (!reply) throw new Error(`unmocked ${key}`);
    const r = reply(req);
    return { status: r.status ?? 200, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  });
});
afterEach(() => {
  setAmazonTransportForTests(null);
  vi.useRealTimers();
  delete process.env.DRY_RUN;
  vi.restoreAllMocks();
});

describe('SigV4 (AuthorizationSigner.php parity)', () => {
  const creds = { key: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

  it('signs an SP-API PATCH with a double-encoded path exactly like the vendor signer', () => {
    const req: AmazonRequest = {
      method: 'PATCH',
      url: 'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/ACSZZXVQ8ZU60/AB%20C%2Fd%28x%29?marketplaceIds=ATVPDKIKX0DER%2CA1AM78C64UM0Y8&issueLocale=en_US&includedData=summaries%2Cattributes',
      headers: {
        'User-Agent': 'jlevers/selling-partner-api/5.10.2 (Language=PHP)', Accept: 'application/json',
        'Content-Type': 'application/json', Host: 'sellingpartnerapi-na.amazon.com',
      },
      body: '{"a":1}',
    };
    const signed = signRequestV4(req, { ...creds, token: 'tok' }, 'execute-api');
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/us-east-1/execute-api/aws4_request, SignedHeaders=accept;content-type;host;user-agent, Signature=3830739c4f33812254a8999dabb3253555146ae4b7c3e9a5f7b73d8b2bef9ce8',
    );
    expect(signed.headers['x-amz-date']).toBe('20260102T030405Z');
  });

  it('signs the STS AssumeRole request exactly like the vendor signer', () => {
    const req: AmazonRequest = {
      method: 'POST',
      url: 'https://sts.us-east-1.amazonaws.com?Action=AssumeRole&RoleArn=arn%3Aaws%3Aiam%3A%3A1%3Arole%2FSpApiRole&RoleSessionName=spapi-assumerole-1&Version=2011-06-15',
      headers: { Accept: 'application/json', Host: 'sts.us-east-1.amazonaws.com' },
    };
    expect(signRequestV4(req, creds, 'sts').headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/us-east-1/sts/aws4_request, SignedHeaders=accept;host, Signature=60f0af578fde26d89cade069a28ad7cfea97f262d23123c0a6d0d61d8f6abea1',
    );
  });
});

describe('auth chain', () => {
  it('LWA refresh-token POST, then STS AssumeRole, then the signed SP-API call; tokens are cached', async () => {
    replies['GET /listings/2021-08-01/items/ACSZZXVQ8ZU60/SKU-1'] = () => ({ body: { sku: 'SKU-1' } });
    const api = new AmazonApi();
    await api.getListing('SKU-1');
    await api.getListing('SKU-1');
    expect(calls.map((c) => url(c).host)).toEqual([
      'api.amazon.com', 'sts.us-east-1.amazonaws.com', 'sellingpartnerapi-na.amazon.com', 'sellingpartnerapi-na.amazon.com',
    ]);
    const [lwa, sts, sp] = calls;
    expect(lwa).toMatchObject({ method: 'POST', url: 'https://api.amazon.com/auth/o2/token', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(lwa.body!)).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' });
    expect(sts.method).toBe('POST');
    expect(sts.url).toBe(
      'https://sts.us-east-1.amazonaws.com?Action=AssumeRole&RoleArn=arn%3Aaws%3Aiam%3A%3A1%3Arole%2FSpApiRole&RoleSessionName=spapi-assumerole-1767323045&Version=2011-06-15',
    );
    expect(sts.headers).toMatchObject({ Accept: 'application/json', 'x-amz-access-token': 'LWA' });
    expect(sts.headers.Authorization).toContain('Credential=AKIDEXAMPLE/20260102/us-east-1/sts/aws4_request');
    expect(sts.headers['x-amz-security-token']).toBeUndefined();
    expect(sp.headers).toMatchObject({
      'x-amz-access-token': 'LWA', 'x-amz-security-token': 'RT', 'x-amz-date': '20260102T030405Z',
      'User-Agent': 'jlevers/selling-partner-api/5.10.2 (Language=PHP)', Accept: 'application/json', 'Content-Type': 'application/json',
      Host: 'sellingpartnerapi-na.amazon.com',
    });
    expect(sp.headers.Authorization).toContain('Credential=RK/20260102/us-east-1/execute-api/aws4_request, SignedHeaders=accept;content-type;host;user-agent');
  });

  it('non-2xx throws an ApiException-style "[code] body" error', async () => {
    replies['GET /listings/2021-08-01/items/ACSZZXVQ8ZU60/X'] = () => ({ status: 404, body: '{"errors":[{"code":"NotFound"}]}' });
    await expect(new AmazonApi().getListing('X')).rejects.toMatchObject({
      name: 'AmazonApiError', status: 404, message: '[404] {"errors":[{"code":"NotFound"}]}',
    });
  });
});

describe('getShippingRates', () => {
  const items = [{ itemId: 'OI1', qty: 2 }, { itemId: 'OI2', qty: 1 }];
  const svc = (name: string, rate?: string) => ({ ShippingServiceName: name, ShippingServiceId: `id-${name}`, ...(rate ? { Rate: { CurrencyCode: 'USD', Amount: rate } } : {}) });

  it('sends both eligibleShippingServices bodies and merges rated services by name', async () => {
    let n = 0;
    replies['POST /mfn/v0/eligibleShippingServices'] = () =>
      n++ === 0
        ? { body: { payload: { ShippingServiceList: [svc('UPS Ground', '8.10'), svc('No Rate')] } } }
        : { body: { payload: { ShippingServiceList: [svc('UPS Ground', '7.00'), svc('USPS Ground Advantage', '4.25')] } } };
    const out = await new AmazonApi().getShippingRates('111-1', 6, '5', 4, 10, items);

    const posts = spCalls();
    expect(posts).toHaveLength(2);
    expect(posts[0].method).toBe('POST');
    expect(posts[0].url).toBe('https://sellingpartnerapi-na.amazon.com/mfn/v0/eligibleShippingServices');
    const expectBody = (de: string) => ({
      ShipmentRequestDetails: {
        AmazonOrderId: '111-1',
        ItemList: [{ OrderItemId: 'OI1', Quantity: 2 }, { OrderItemId: 'OI2', Quantity: 1 }],
        ShipFromAddress: {
          Name: 'Angel Isabella, LLC', AddressLine1: '1550 oak industrial ln', AddressLine2: 'Ste F', Email: 'contact@angelisabella.com',
          City: 'Cumming', StateOrProvinceCode: 'GA', PostalCode: '30041', CountryCode: 'US',
        },
        PackageDimensions: { Length: 6, Width: '5', Height: 4, Unit: 'inches' },
        Weight: { Value: 10, Unit: 'oz' },
        ShippingServiceOptions: { DeliveryExperience: de, LabelFormat: 'PNG' },
      },
    });
    expect(JSON.parse(posts[0].body!)).toEqual(expectBody('DeliveryConfirmationWithoutSignature'));
    expect(JSON.parse(posts[1].body!)).toEqual(expectBody('NoTracking'));
    expect(out.map((s) => [s.shipping_service_name, s.rate.amount])).toEqual([['UPS Ground', '8.10'], ['USPS Ground Advantage', '4.25']]);
    expect(out[0]).toMatchObject({ shipping_service_id: 'id-UPS Ground', rate: { currency_code: 'USD', amount: '8.10' } });
  });

  it('sends MustArriveByDate/ShipDate only when given', async () => {
    replies['POST /mfn/v0/eligibleShippingServices'] = () => ({ body: { payload: { ShippingServiceList: [] } } });
    await new AmazonApi().getShippingRates('111-1', 1, 1, 1, 1, items, '2026-01-03T00:00:00Z', '2026-01-09T00:00:00Z');
    expect(JSON.parse(spCalls()[0].body!).ShipmentRequestDetails).toMatchObject({ ShipDate: '2026-01-03T00:00:00Z', MustArriveByDate: '2026-01-09T00:00:00Z' });
  });
});

describe('createShipment (write)', () => {
  const shipment = { payload: { ShipmentId: 'S1', TrackingId: 'T1', Label: { FileContents: { Contents: 'H4sI', FileType: 'image/png' } }, ShippingService: { Rate: { Amount: 5.1 } } } };

  it('POSTs /mfn/v0/shipments with the service id and returns the snake_case payload', async () => {
    replies['POST /mfn/v0/shipments'] = () => ({ body: shipment });
    const out = await new AmazonApi().createShipment('111-1', 6, 6, 4, 10, [{ itemId: 'OI1', qty: 1 }], 'UPS_PTP_GROUND');
    const sent = JSON.parse(spCalls()[0].body!);
    expect(sent.ShippingServiceId).toBe('UPS_PTP_GROUND');
    expect('ShippingServiceOfferId' in sent).toBe(false);
    expect(sent.ShipmentRequestDetails.ShippingServiceOptions).toEqual({ DeliveryExperience: 'DeliveryConfirmationWithoutSignature', LabelFormat: 'PNG' });
    expect(out.tracking_id).toBe('T1');
    expect(out.label.file_contents.contents).toBe('H4sI');
    expect(out.shipping_service.rate.amount).toBe(5.1);
    expect(out.shipment_id).toBe('S1');
  });

  it('UPS_PTP_GROUNDSAVER uses NoTracking and an offer id is passed through', async () => {
    replies['POST /mfn/v0/shipments'] = () => ({ body: shipment });
    await new AmazonApi().createShipment('111-1', 6, 6, 4, 10, [], 'UPS_PTP_GROUNDSAVER', 'offer-1');
    const sent = JSON.parse(spCalls()[0].body!);
    expect(sent.ShipmentRequestDetails.ShippingServiceOptions.DeliveryExperience).toBe('NoTracking');
    expect(sent.ShippingServiceOfferId).toBe('offer-1');
  });

  it('DRY_RUN=1 never reaches the transport (not even LWA)', async () => {
    process.env.DRY_RUN = '1';
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(new AmazonApi().createShipment('111-1', 6, 6, 4, 10, [], 'X')).rejects.toBeInstanceOf(AmazonApiError);
    expect(calls).toHaveLength(0);
  });
});

describe('reports', () => {
  it('requestReport posts the report spec with the three NA marketplaces and default 89-day window', async () => {
    replies['POST /reports/2021-06-30/reports'] = () => ({ body: { reportId: '840645019555' } });
    const out = await new AmazonApi().requestReport();
    expect(out).toEqual({ report_id: '840645019555' });
    expect(JSON.parse(spCalls()[0].body!)).toEqual({
      reportType: 'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING',
      dataStartTime: '2025-10-05T03:04:05Z',
      dataEndTime: '2026-01-02T03:04:05Z',
      marketplaceIds: ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8'],
    });
  });

  it('requestReport passes explicit dates', async () => {
    replies['POST /reports/2021-06-30/reports'] = () => ({ body: { reportId: 'r' } });
    await new AmazonApi().requestReport('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', 'a', 'b');
    expect(JSON.parse(spCalls()[0].body!)).toMatchObject({ reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', dataStartTime: 'a', dataEndTime: 'b' });
  });

  it('getReportRequestList: GET with reportTypes/processingStatuses/pageSize=10/createdSince(7 days)', async () => {
    replies['GET /reports/2021-06-30/reports'] = () => ({ body: { reports: [{ reportId: '1', reportType: 'T', reportDocumentId: 'D', processingStatus: 'DONE' }] } });
    const out = await new AmazonApi().getReportRequestList();
    expect(spCalls()[0].url).toBe(
      'https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports?reportTypes=GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING&processingStatuses=DONE&pageSize=10&createdSince=2025-12-26T03%3A04%3A05Z',
    );
    expect(out.reports[0]).toEqual({ report_id: '1', report_type: 'T', report_document_id: 'D', processing_status: 'DONE' });
  });

  it('getReportDocument for an unrestricted type uses the LWA token and no query', async () => {
    replies['GET /reports/2021-06-30/documents/amzn1.spdoc.1'] = () => ({ body: { reportDocumentId: 'amzn1.spdoc.1', url: 'https://tortuga.example/x' } });
    const out = await new AmazonApi().getReportDocument('amzn1.spdoc.1', 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL');
    expect(out).toEqual({ report_document_id: 'amzn1.spdoc.1', url: 'https://tortuga.example/x' });
    const sp = spCalls();
    expect(sp).toHaveLength(1);
    expect(sp[0].url).toBe('https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/amzn1.spdoc.1');
    expect(sp[0].headers['x-amz-access-token']).toBe('LWA');
  });

  it('getReportDocument for a restricted type first requests a restricted data token and sends it as the access token', async () => {
    replies['GET /reports/2021-06-30/documents/doc1'] = () => ({ body: { reportDocumentId: 'doc1', url: 'u' } });
    await new AmazonApi().getReportDocument('doc1', 'GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING');
    const sp = spCalls();
    expect(sp.map((c) => `${c.method} ${url(c).pathname}`)).toEqual(['POST /tokens/2021-03-01/restrictedDataToken', 'GET /reports/2021-06-30/documents/doc1']);
    expect(JSON.parse(sp[0].body!)).toEqual({ restrictedResources: [{ method: 'GET', path: '/reports/2021-06-30/documents/doc1' }] });
    expect(sp[0].headers['x-amz-access-token']).toBe('LWA');
    expect(sp[1].headers['x-amz-access-token']).toBe('RDT');
    expect(sp[1].headers['x-amz-security-token']).toBe('RT');
  });
});

describe('listings', () => {
  it('getListing: GET with marketplaceIds/issueLocale/includedData; attributes keep Amazon keys, summaries are snake_case', async () => {
    replies['GET /listings/2021-08-01/items/ACSZZXVQ8ZU60/0U-RXX8%20YRT1'] = () => ({
      body: {
        sku: '0U-RXX8 YRT1',
        summaries: [{ marketplaceId: 'ATVPDKIKX0DER', productType: 'ARTIFICIAL_PLANT', itemName: 'Fern', mainImage: { link: 'l' } }],
        attributes: { bullet_point: [{ value: 'b1', language_tag: 'en_US' }], main_product_image_locator: [{ media_location: 'http://m' }] },
      },
    });
    const out = await new AmazonApi().getListing('0U-RXX8 YRT1');
    expect(spCalls()[0].url).toBe(
      'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/ACSZZXVQ8ZU60/0U-RXX8%20YRT1?marketplaceIds=ATVPDKIKX0DER&issueLocale=en_US&includedData=summaries%2Cattributes%2Cprocurement',
    );
    expect(out.summaries[0]).toEqual({ marketplace_id: 'ATVPDKIKX0DER', product_type: 'ARTIFICIAL_PLANT', item_name: 'Fern', main_image: { link: 'l' } });
    expect(out.attributes.bullet_point[0]).toEqual({ value: 'b1', language_tag: 'en_US' });
    expect(out.attributes.main_product_image_locator[0].media_location).toBe('http://m');
  });

  it('patchListing: PATCH with the three replace patches and all three marketplaces', async () => {
    replies['PATCH /listings/2021-08-01/items/ACSZZXVQ8ZU60/SKU1'] = () => ({ body: { sku: 'SKU1', status: 'ACCEPTED', submissionId: 'sub1', issues: [] } });
    const out = await new AmazonApi().patchListing('SKU1', 'ARTIFICIAL_PLANT', 'Name', 'Desc', [{ value: 'b1' }]);
    expect(out).toEqual({ sku: 'SKU1', status: 'ACCEPTED', submission_id: 'sub1', issues: [] });
    const c = spCalls()[0];
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe(
      'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/ACSZZXVQ8ZU60/SKU1?marketplaceIds=ATVPDKIKX0DER%2CA1AM78C64UM0Y8%2CA2EUQ1WTGCTBG2&issueLocale=en_US',
    );
    expect(JSON.parse(c.body!)).toEqual({
      productType: 'ARTIFICIAL_PLANT',
      patches: [
        { op: 'replace', path: '/attributes/product_description', value: [{ value: 'Desc' }] },
        { op: 'replace', path: '/attributes/item_name', value: [{ value: 'Name' }] },
        { op: 'replace', path: '/attributes/bullet_point', value: [{ value: 'b1' }] },
      ],
    });
  });

  it('patchListing DRY_RUN=1 sends nothing', async () => {
    process.env.DRY_RUN = '1';
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(new AmazonApi().patchListing('S', 'T', 'N', 'D', [])).rejects.toBeInstanceOf(AmazonApiError);
    expect(calls).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('getPriorDays / getFormattedTimestamp format like gmdate', () => {
    expect(getFormattedTimestamp()).toBe('2026-01-02T03:04:05Z');
    expect(getPriorDays(29)).toBe('2025-12-04T03:04:05Z');
    expect(new AmazonApi().getPriorDays(1)).toBe('2026-01-01T03:04:05Z');
  });

  it('uncompress gunzips the label and copies non-gzip input as is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l04-'));
    writeFileSync(join(dir, 'a.gz'), gzipSync(Buffer.from('PNGDATA')));
    new AmazonApi().uncompress(join(dir, 'a.gz'), join(dir, 'a.png'));
    expect(readFileSync(join(dir, 'a.png'), 'utf8')).toBe('PNGDATA');
    writeFileSync(join(dir, 'b.gz'), 'plain');
    new AmazonApi().uncompress(join(dir, 'b.gz'), join(dir, 'b.png'));
    expect(readFileSync(join(dir, 'b.png'), 'utf8')).toBe('plain');
  });

  it('camelizeModel/pascalizeModel invert snakeModel for the PHP json_encode(model) shape', () => {
    const m = { shipping_service_id: 'x', rate: { currency_code: 'USD', amount: 1 }, attributes: { keep_me: 1 } };
    expect(pascalizeModel(m)).toEqual({ ShippingServiceId: 'x', Rate: { CurrencyCode: 'USD', Amount: 1 }, Attributes: { keep_me: 1 } });
    expect(camelizeModel(m)).toEqual({ shippingServiceId: 'x', rate: { currencyCode: 'USD', amount: 1 }, attributes: { keep_me: 1 } });
  });
});
