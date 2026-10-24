// L02: App\Libraries\FedexClient + UpsClient ports. Nothing reaches FedEx/UPS: FedEx is mocked at
// setFedexTransportForTests (plus one real-SOAP pass against a loopback HTTP server), UPS at global fetch.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// storage.ts reads STORAGE_DIR at import time
const storageDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'l02-storage-'));
  process.env.STORAGE_DIR = dir;
  return dir;
});

import { FedexClient, setFedexTransportForTests } from '../src/lib/fedex.js';
import { parseXml, UpsClient } from '../src/lib/ups.js';

const warehouse = {
  Contact: { PersonName: 'W', CompanyName: 'Angel Isabella', PhoneNumber: '5551234567' },
  Address: { StreetLines: ['1 Dock Rd', 'Bldg 2'], City: 'Atlanta', StateOrProvinceCode: 'GA', PostalCode: '30301', CountryCode: 'US' },
};

beforeEach(() => {
  Object.assign(process.env, {
    FEDEX_URL: 'https://ws.fedex.com:443/web-services',
    FEDEX_KEY: 'fkey',
    FEDEX_PASSWORD: 'fpass',
    FEDEX_ACCOUNT: '111',
    FEDEX_WALMART_ACCOUNT: '999',
    FEDEX_METER: '222',
    UPS_ACCESS_KEY: 'akey',
    UPS_USER_ID: 'uid',
    UPS_PASSWORD: 'upass',
    UPS_AI_ACCOUNT: '727961',
    UPS_WM_ACCOUNT: 'X3684X',
    UPS_SANDBOX: 'false',
  });
  delete process.env.DRY_RUN;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  setFedexTransportForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DRY_RUN;
});

// ---------------------------------------------------------------- FedEx (mocked transport)

type Call = { service: string; operation: string; params: any };
function mockFedex(reply: any): Call[] {
  const calls: Call[] = [];
  setFedexTransportForTests(async (service, operation, params) => {
    calls.push({ service, operation, params });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(params) : reply;
  });
  return calls;
}

const rateReply = (details: any) => ({ HighestSeverity: 'SUCCESS', RateReplyDetails: details });
const detail = (serviceType: string, amount: string, extra: any = {}) => ({
  ServiceType: serviceType,
  RatedShipmentDetails: { ShipmentRateDetail: { TotalNetCharge: { Currency: 'USD', Amount: amount } } },
  ...extra,
});

describe('FedexClient request builders', () => {
  it('addRecipient / payments / label spec / special services match the PHP arrays', () => {
    const f = new FedexClient();
    expect(f.addRecipient('N', true, ['a', 'b'], 'C', 'GA', '30301', 'US', '555')).toEqual({
      Contact: { PersonName: 'N', CompanyName: '', PhoneNumber: '555' },
      Address: { StreetLines: ['a', 'b'], City: 'C', StateOrProvinceCode: 'GA', PostalCode: '30301', CountryCode: 'US', Residential: 1 },
    });
    expect(f.addRecipient('N', false, [], 'C', 'GA', 'Z').Address).toMatchObject({ Residential: 0, CountryCode: 'US' });
    expect(f.addShippingChargesPayment()).toEqual({
      PaymentType: 'SENDER',
      Payor: { ResponsibleParty: { AccountNumber: '111', CountryCode: 'US' } },
    });
    expect(f.addThirdPartyChargesPayment().Payor).toEqual({ ResponsibleParty: { AccountNumber: '999', CountryCode: 'US' } });
    expect(f.addLabelSpecification()).toEqual({ LabelFormatType: 'COMMON2D', ImageType: 'PNG', LabelStockType: 'PAPER_4X6' });
    expect(f.addSpecialServicesOneRate()).toEqual({ SpecialServiceTypes: ['FEDEX_ONE_RATE'] });
    expect(f.addSpecialServicesSignature()).toEqual({ SpecialServiceTypes: ['SIGNATURE_OPTION'], SignatureOptionDetail: { OptionType: 'ADULT' } });
  });

  it('addPackageLineItem1: references (po falls back to orderId) and signature', () => {
    const f = new FedexClient();
    expect(f.addPackageLineItem1(false, 10, 8, 6, 2.5)).toEqual({
      SequenceNumber: 1,
      GroupPackageCount: 1,
      Weight: { Value: 2.5, Units: 'LB' },
      Dimensions: { Length: 10, Width: 8, Height: 6, Units: 'IN' },
    });
    const withOrder = f.addPackageLineItem1(true, 1, 2, 3, 4, 'A1', '');
    expect(withOrder.CustomerReferences).toEqual([
      { CustomerReferenceType: 'CUSTOMER_REFERENCE', Value: 'A1' },
      { CustomerReferenceType: 'P_O_NUMBER', Value: 'A1' },
    ]);
    expect(withOrder.SpecialServicesRequested).toEqual(f.addSpecialServicesSignature());
    expect(f.addPackageLineItem1(false, 1, 2, 3, 4, 'A1', 'PO9').CustomerReferences).toEqual([
      { CustomerReferenceType: 'CUSTOMER_REFERENCE', Value: 'A1' },
      { CustomerReferenceType: 'P_O_NUMBER', Value: 'PO9' },
    ]);
  });
});

describe('FedexClient.getRate / getOneRate', () => {
  it('getRate sends the v28 getRates request and formats an array reply', async () => {
    const calls = mockFedex(
      rateReply([detail('FEDEX_GROUND', '12.345', { TransitTime: 'TWO_DAYS' }), detail('GROUND_HOME_DELIVERY', '1234.5', { DeliveryTimestamp: '2025-01-03T12:00:00' })]),
    );
    const rates = await new FedexClient().getRate(warehouse, 10, 8, 6, 2.5, true, true, ['1 Main', ''], 'Austin', 'TX', '78701');
    expect(rates).toEqual([
      { serviceType: 'FEDEX_GROUND', amount: '12.35', deliveryDate: 'TWO_DAYS' },
      { serviceType: 'GROUND_HOME_DELIVERY', amount: '1,234.50', deliveryDate: '2025-01-03T12:00:00' },
    ]);
    expect(calls).toHaveLength(1);
    const { service, operation, params } = calls[0];
    expect([service, operation]).toEqual(['rate', 'getRates']);
    expect(params.WebAuthenticationDetail).toEqual({ UserCredential: { Key: 'fkey', Password: 'fpass' } });
    expect(params.ClientDetail).toEqual({ AccountNumber: '111', MeterNumber: '222' });
    expect(params.TransactionDetail).toEqual({ CustomerTransactionId: ' *** Rate Request using PHP ***' });
    expect(params.Version).toEqual({ ServiceId: 'crs', Major: '28', Intermediate: '0', Minor: '0' });
    expect(params.ReturnTransitAndCommit).toBe(true);
    const shipment = params.RequestedShipment;
    expect(shipment).toMatchObject({
      DropoffType: 'REGULAR_PICKUP',
      ServiceType: 'GROUND_HOME_DELIVERY',
      PackagingType: 'YOUR_PACKAGING',
      Shipper: warehouse,
      PackageCount: '1',
    });
    expect(shipment.ShipTimestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(shipment.Recipient.Contact.PersonName).toBe('test');
    expect(shipment.Recipient.Address).toMatchObject({ StreetLines: ['1 Main', ''], City: 'Austin', Residential: 1 });
    expect(shipment.RequestedPackageLineItems.SpecialServicesRequested.SpecialServiceTypes).toEqual(['SIGNATURE_OPTION']);
    expect(shipment.RequestedPackageLineItems.CustomerReferences).toBeUndefined();
  });

  it('getRate: commercial address uses FEDEX_GROUND; single (non-array) reply detail is handled', async () => {
    const calls = mockFedex(rateReply(detail('FEDEX_GROUND', '9', { TransitTime: 'ONE_DAY' })));
    const rates = await new FedexClient().getRate(warehouse, 1, 1, 1, 1, false, false, ['a', 'b'], 'c', 'GA', '30301');
    expect(rates).toEqual([{ serviceType: 'FEDEX_GROUND', amount: '9.00', deliveryDate: 'ONE_DAY' }]);
    expect(calls[0].params.RequestedShipment.ServiceType).toBe('FEDEX_GROUND');
  });

  it('getRate: RatedShipmentDetails as an array uses element 0', async () => {
    mockFedex(
      rateReply({
        ServiceType: 'X',
        DeliveryTimestamp: 'T',
        RatedShipmentDetails: [{ ShipmentRateDetail: { TotalNetCharge: { Amount: '5.5' } } }, { ShipmentRateDetail: { TotalNetCharge: { Amount: '7' } } }],
      }),
    );
    expect(await new FedexClient().getRate(warehouse, 1, 1, 1, 1, false, false, ['a'], 'c', 'GA', '1')).toEqual([
      { serviceType: 'X', amount: '5.50', deliveryDate: 'T' },
    ]);
  });

  it('getRate: FAILURE / ERROR severity or a SOAP fault yields []; a reply with no delivery info is an undefined-variable error', async () => {
    const f = new FedexClient();
    for (const sev of ['FAILURE', 'ERROR']) {
      mockFedex({ HighestSeverity: sev });
      expect(await f.getRate(warehouse, 1, 1, 1, 1, false, false, ['a'], 'c', 'GA', '1')).toEqual([]);
    }
    const { FedexFault } = await import('../src/lib/fedex.js');
    mockFedex(new FedexFault('boom'));
    expect(await f.getRate(warehouse, 1, 1, 1, 1, false, false, ['a'], 'c', 'GA', '1')).toEqual([]);
    mockFedex(rateReply(detail('X', '1')));
    await expect(f.getRate(warehouse, 1, 1, 1, 1, false, false, ['a'], 'c', 'GA', '1')).rejects.toThrow('Undefined variable: deliveryDate');
  });

  it('getOneRate sends One Rate special services, packaging + serviceType, and no weight/dimensions', async () => {
    const calls = mockFedex(rateReply(detail('FEDEX_EXPRESS_SAVER', '20', { DeliveryTimestamp: 'D' })));
    const rates = await new FedexClient().getOneRate(warehouse, 1, 1, 1, 3, 'FEDEX_SMALL_BOX', false, ['a', 'b'], 'c', 'GA', '30301');
    expect(rates).toEqual([{ serviceType: 'FEDEX_EXPRESS_SAVER', amount: '20.00', deliveryDate: 'D' }]);
    const shipment = calls[0].params.RequestedShipment;
    expect(shipment).toMatchObject({
      SpecialServicesRequested: { SpecialServiceTypes: ['FEDEX_ONE_RATE'] },
      ServiceType: 'FEDEX_EXPRESS_SAVER',
      PackagingType: 'FEDEX_SMALL_BOX',
      RequestedPackageLineItems: { SequenceNumber: 1, GroupPackageCount: 1 },
    });
    expect(Object.keys(shipment.RequestedPackageLineItems)).toEqual(['SequenceNumber', 'GroupPackageCount']);
  });
});

describe('FedexClient.validateAddress', () => {
  it('sends the v4 addressValidation request and returns Classification + EffectiveAddress', async () => {
    const calls = mockFedex({
      HighestSeverity: 'SUCCESS',
      AddressResults: { Classification: 'RESIDENTIAL', EffectiveAddress: { City: 'AUSTIN' }, Other: 1 },
    });
    expect(await new FedexClient().validateAddress(['1 Main', 'Apt 2'], 'Austin', 'TX', '78701')).toEqual({
      Classification: 'RESIDENTIAL',
      EffectiveAddress: { City: 'AUSTIN' },
    });
    expect(calls[0].service).toBe('addressvalidation');
    expect(calls[0].operation).toBe('addressValidation');
    expect(calls[0].params.Version).toEqual({ ServiceId: 'aval', Major: '4', Intermediate: '0', Minor: '0' });
    expect(calls[0].params.AddressesToValidate).toEqual([
      {
        ClientReferenceId: 'ClientReferenceId1',
        Address: { StreetLines: ['1 Main', 'Apt 2'], PostalCode: '78701', City: 'Austin', StateOrProvinceCode: 'TX', CountryCode: 'US' },
      },
    ]);
  });

  it('returns [] on failure severity or a fault', async () => {
    mockFedex({ HighestSeverity: 'ERROR' });
    expect(await new FedexClient().validateAddress(['a'], 'c', 'GA', '1')).toEqual([]);
    const { FedexFault } = await import('../src/lib/fedex.js');
    mockFedex(new FedexFault('x'));
    expect(await new FedexClient().validateAddress(['a'], 'c', 'GA', '1')).toEqual([]);
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const shipReply = (extra: any = {}) => ({
  HighestSeverity: 'SUCCESS',
  CompletedShipmentDetail: {
    MasterTrackingId: { TrackingNumber: 'MASTER1' },
    CompletedPackageDetails: {
      TrackingIds: { TrackingNumber: 'PKG1' },
      Label: { Parts: { Image: PNG.toString('base64') } },
      PackageRating: { PackageRateDetails: { NetCharge: { Currency: 'USD', Amount: '8.25' } } },
      ...extra,
    },
  },
});

describe('FedexClient.getLabel', () => {
  const ship = (f: FedexClient, serviceType: string, packageType: string, thirdParty = false, orderId = 'L02-ORD', po = '') =>
    f.getLabel(orderId, po, warehouse, packageType, serviceType, 10, 8, 6, 2.5, true, true, 'Bob', '5559999999', ['1 Main', ''], 'Austin', 'TX', '78701', 'US', thirdParty);

  it('FEDEX_GROUND: processShipment request, PNG written to the labels disk, tracking/netcharge returned', async () => {
    const calls = mockFedex(shipReply());
    const label = await ship(new FedexClient(), 'FEDEX_GROUND', 'FEDEX_GROUND', false, 'L02-ORD', 'PO1');
    expect(label).toEqual({ tracking: 'PKG1', label: `${storageDir}/app/public/labels/labels/L02-ORD.png`, netcharge: 8.25 });
    expect(readFileSync(label!.label).equals(PNG)).toBe(true);
    expect(statSync(label!.label).mode & 0o777).toBe(0o666);

    const { service, operation, params } = calls[0];
    expect([service, operation]).toEqual(['ship', 'processShipment']);
    expect(params.Version).toEqual({ ServiceId: 'ship', Major: '23', Intermediate: '0', Minor: '0' });
    expect(params.ReturnTransitAndCommit).toBe(true);
    const s = params.RequestedShipment;
    expect(s).toMatchObject({
      DropoffType: 'REGULAR_PICKUP',
      PackagingType: 'YOUR_PACKAGING',
      ServiceType: 'GROUND_HOME_DELIVERY',
      Shipper: warehouse,
      PackageCount: '1',
      LabelSpecification: { LabelFormatType: 'COMMON2D', ImageType: 'PNG', LabelStockType: 'PAPER_4X6' },
    });
    expect(s.ShippingChargesPayment.PaymentType).toBe('SENDER');
    expect(s.ShippingChargesPayment.Payor.ResponsibleParty.AccountNumber).toBe('111');
    expect(s.Recipient.Contact).toEqual({ PersonName: 'Bob', CompanyName: '', PhoneNumber: '5559999999' });
    expect(s.RequestedPackageLineItems.CustomerReferences).toEqual([
      { CustomerReferenceType: 'CUSTOMER_REFERENCE', Value: 'L02-ORD' },
      { CustomerReferenceType: 'P_O_NUMBER', Value: 'PO1' },
    ]);
    expect(s.RequestedPackageLineItems.SpecialServicesRequested.SpecialServiceTypes).toEqual(['SIGNATURE_OPTION']);
    expect(s.SpecialServicesRequested).toBeUndefined();
  });

  it('non-ground (One Rate box) + third-party: package type/service passed through, weight only, walmart account pays', async () => {
    const calls = mockFedex(shipReply({ PackageRating: undefined }));
    const label = await ship(new FedexClient(), 'FEDEX_EXPRESS_SAVER', 'FEDEX_SMALL_BOX', true, 'L02-EXP');
    expect(label).toEqual({ tracking: 'PKG1', label: `${storageDir}/app/public/labels/labels/L02-EXP.png` });
    const s = calls[0].params.RequestedShipment;
    expect(s).toMatchObject({
      ServiceType: 'FEDEX_EXPRESS_SAVER',
      PackagingType: 'FEDEX_SMALL_BOX',
      SpecialServicesRequested: { SpecialServiceTypes: ['FEDEX_ONE_RATE'] },
    });
    expect(s.ShippingChargesPayment).toEqual({
      PaymentType: 'THIRD_PARTY',
      Payor: { ResponsibleParty: { AccountNumber: '999', CountryCode: 'US' } },
    });
    expect(s.RequestedPackageLineItems).toEqual({
      SequenceNumber: 1,
      GroupPackageCount: 1,
      Weight: { Value: 2.5, Units: 'LB' },
      CustomerReferences: [{ CustomerReferenceType: 'CUSTOMER_REFERENCE', Value: 'L02-EXP' }],
    });
  });

  it('falls back to the master tracking number when the package has no TrackingIds', async () => {
    mockFedex(shipReply({ TrackingIds: undefined }));
    expect((await ship(new FedexClient(), 'FEDEX_GROUND', 'FEDEX_GROUND', false, 'L02-MASTER'))?.tracking).toBe('MASTER1');
  });

  it('FAILURE severity / fault -> null (no label written)', async () => {
    mockFedex({ HighestSeverity: 'FAILURE' });
    expect(await ship(new FedexClient(), 'FEDEX_GROUND', 'FEDEX_GROUND')).toBeNull();
    const { FedexFault } = await import('../src/lib/fedex.js');
    mockFedex(new FedexFault('soap down'));
    expect(await ship(new FedexClient(), 'FEDEX_GROUND', 'FEDEX_GROUND')).toBeNull();
  });

  it('DRY_RUN=1 never reaches the transport and returns null', async () => {
    process.env.DRY_RUN = '1';
    const calls = mockFedex(shipReply());
    expect(await ship(new FedexClient(), 'FEDEX_GROUND', 'FEDEX_GROUND', false, 'L02-DRY')).toBeNull();
    expect(await new FedexClient().deleteShipment('794')).toBeNull();
    expect(calls).toEqual([]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('[DRY_RUN] FedEx processShipment not sent'), expect.any(String));
    expect(JSON.stringify((console.info as any).mock.calls)).not.toContain('fpass');
  });
});

describe('FedexClient.deleteShipment', () => {
  it("sends v23 deleteShipment for the tracking id and returns 'OK'", async () => {
    const calls = mockFedex({ HighestSeverity: 'SUCCESS' });
    expect(await new FedexClient().deleteShipment('794600000000')).toBe('OK');
    const { service, operation, params } = calls[0];
    expect([service, operation]).toEqual(['ship', 'deleteShipment']);
    expect(params.TransactionDetail).toEqual({ CustomerTransactionId: 'Delete shipment 794600000000' });
    expect(params.TrackingId).toEqual({ TrackingIdType: 'FEDEX', TrackingNumber: '794600000000' });
    expect(params.DeletionControl).toBe('DELETE_ONE_PACKAGE');
    expect(params.ShipTimestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(params.ReturnTransitAndCommit).toBeUndefined();
  });

  it('returns null on failure severity or a fault', async () => {
    mockFedex({ HighestSeverity: 'FAILURE' });
    expect(await new FedexClient().deleteShipment('1')).toBeNull();
    const { FedexFault } = await import('../src/lib/fedex.js');
    mockFedex(new FedexFault('x'));
    expect(await new FedexClient().deleteShipment('1')).toBeNull();
  });
});

// ---------------------------------------------------------------- FedEx (real node-soap against a loopback server)

describe('FedEx over real SOAP (loopback)', () => {
  let server: Server;
  let seen: { url?: string; headers?: IncomingMessage['headers']; body?: string };
  let reply: string;
  const envelope = (body: string) =>
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  beforeEach(async () => {
    seen = {};
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body };
        res.setHeader('Content-Type', 'text/xml');
        res.end(reply);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.FEDEX_URL = `http://127.0.0.1:${(server.address() as any).port}/web-services`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('getRate: POST /web-services/rate with schema-ordered body, booleans as true/false, decoded reply', async () => {
    reply = envelope(
      '<RateReply xmlns="http://fedex.com/ws/rate/v28"><HighestSeverity>SUCCESS</HighestSeverity>' +
        '<RateReplyDetails><ServiceType>FEDEX_GROUND</ServiceType><TransitTime>TWO_DAYS</TransitTime><RatedShipmentDetails><ShipmentRateDetail><TotalNetCharge><Currency>USD</Currency><Amount>1234.5</Amount></TotalNetCharge></ShipmentRateDetail></RatedShipmentDetails></RateReplyDetails></RateReply>',
    );
    const rates = await new FedexClient().getRate(warehouse, 10, 8, 6, 2.5, true, false, ['1 Main', 'Apt 2'], 'Austin', 'TX', '78701');
    expect(rates).toEqual([{ serviceType: 'FEDEX_GROUND', amount: '1,234.50', deliveryDate: 'TWO_DAYS' }]);
    expect(seen.url).toBe('/web-services/rate');
    expect(seen.headers!['content-type']).toContain('text/xml');
    const body = seen.body!;
    expect(body).toMatch(/<(\w+:)?Key>fkey</);
    expect(body).toMatch(/<(\w+:)?Password>fpass</);
    expect(body).toMatch(/<(\w+:)?AccountNumber>111</);
    expect(body).toMatch(/<(\w+:)?Major>28</);
    expect(body).toMatch(/<(\w+:)?ReturnTransitAndCommit>true</);
    expect(body).toMatch(/<(\w+:)?ServiceType>GROUND_HOME_DELIVERY</);
    expect(body).toMatch(/<(\w+:)?Residential>true</);
    expect(body).toMatch(/<(\w+:)?StreetLines>1 Main<\/(\w+:)?StreetLines><(\w+:)?StreetLines>Apt 2</);
    expect(body).toMatch(/<(\w+:)?Value>2\.5</);
    // WebAuthenticationDetail precedes ClientDetail precedes RequestedShipment (schema order)
    expect(body.indexOf('WebAuthenticationDetail')).toBeLessThan(body.indexOf('ClientDetail'));
    expect(body.indexOf('ClientDetail')).toBeLessThan(body.indexOf('RequestedShipment'));
  });

  it('getLabel: POST /web-services/ship, base64 label decoded to a PNG on disk', async () => {
    reply = envelope(
      '<ProcessShipmentReply xmlns="http://fedex.com/ws/ship/v23"><HighestSeverity>SUCCESS</HighestSeverity>' +
        '<CompletedShipmentDetail><MasterTrackingId><TrackingIdType>FEDEX</TrackingIdType><TrackingNumber>MASTER9</TrackingNumber></MasterTrackingId>' +
        `<CompletedPackageDetails><SequenceNumber>1</SequenceNumber><TrackingIds><TrackingIdType>FEDEX</TrackingIdType><TrackingNumber>PKG9</TrackingNumber></TrackingIds><Label><Type>OUTBOUND_LABEL</Type><Parts><DocumentPartSequenceNumber>1</DocumentPartSequenceNumber><Image>${PNG.toString('base64')}</Image></Parts></Label>` +
        '<PackageRating><PackageRateDetails><NetCharge><Currency>USD</Currency><Amount>8.25</Amount></NetCharge></PackageRateDetails></PackageRating></CompletedPackageDetails></CompletedShipmentDetail></ProcessShipmentReply>',
    );
    const label = await new FedexClient().getLabel('L02-SOAP', '', warehouse, 'FEDEX_GROUND', 'FEDEX_GROUND', 10, 8, 6, 2.5, false, false, 'Bob', '555', ['1 Main', ''], 'Austin', 'TX', '78701', 'US', false);
    expect(seen.url).toBe('/web-services/ship');
    expect(label).toMatchObject({ tracking: 'PKG9', netcharge: 8.25 });
    expect(readFileSync(label!.label).equals(PNG)).toBe(true);
    expect(seen.body).toMatch(/<(\w+:)?LabelStockType>PAPER_4X6</);
    expect(seen.body).toMatch(/<(\w+:)?Residential>false</);
  });

  it('SOAP fault from the server -> fallback value', async () => {
    reply = envelope('<SOAP-ENV:Fault><faultcode>x</faultcode><faultstring>nope</faultstring></SOAP-ENV:Fault>');
    expect(await new FedexClient().validateAddress(['a'], 'c', 'GA', '1')).toEqual([]);
    expect(seen.url).toBe('/web-services/addressvalidation');
  });
});

// ---------------------------------------------------------------- UPS (fetch stubbed)

type Fetched = { url: string; body: string; headers: Record<string, string>; method: string };
function stubFetch(replies: Record<string, string>): Fetched[] {
  const fetched: Fetched[] = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    fetched.push({ url, body: init.body, headers: init.headers, method: init.method });
    const endpoint = url.slice(url.lastIndexOf('/'));
    return new Response(replies[endpoint], { status: 200 });
  });
  return fetched;
}
const upsOk = (inner: string, root = 'Reply') =>
  `<?xml version="1.0"?>\n<${root}><Response><TransactionReference><CustomerContext/></TransactionReference><ResponseStatusCode>1</ResponseStatusCode><ResponseStatusDescription>Success</ResponseStatusDescription></Response>${inner}</${root}>`;
const upsErr = (code: string, desc: string) =>
  `<?xml version="1.0"?><Reply><Response><ResponseStatusCode>0</ResponseStatusCode><Error><ErrorSeverity>Hard</ErrorSeverity><ErrorCode>${code}</ErrorCode><ErrorDescription>${desc}</ErrorDescription></Error></Response></Reply>`;
const ACCESS = `<?xml version="1.0"?>
<AccessRequest xml:lang="en-US">
  <AccessLicenseNumber>akey</AccessLicenseNumber>
  <UserId>uid</UserId>
  <Password>upass</Password>
</AccessRequest>
`;

describe('parseXml (json_encode(SimpleXML) shape)', () => {
  it('maps text to strings, repeats to arrays, empty to {}, attributes to @attributes, decodes entities', () => {
    expect(parseXml('<?xml version="1.0"?><R a="1"><X>a &amp; b</X><Y>1</Y><Y>2</Y><Z/><W><V>q</V></W><C><![CDATA[<raw>]]></C></R>')).toEqual({
      '@attributes': { a: '1' },
      X: 'a & b',
      Y: ['1', '2'],
      Z: {},
      W: { V: 'q' },
      C: '<raw>',
    });
  });
});

describe('UpsClient.getRate', () => {
  it('posts AccessRequest + RatingServiceSelectionRequest (Shoptimeintransit) to /Rate and maps time-in-transit rates', async () => {
    const fetched = stubFetch({
      '/Rate': upsOk(
        '<RatedShipment><Service><Code>03</Code></Service><TotalCharges><CurrencyCode>USD</CurrencyCode><MonetaryValue>12.34</MonetaryValue></TotalCharges>' +
          '<TimeInTransit><PickupDate>20250101</PickupDate><ServiceSummary><Service><Description>UPS Ground</Description></Service><EstimatedArrival><Arrival><Date>20250104</Date><Time>230000</Time></Arrival><Pickup><Date>20250101</Date><Time>160000</Time></Pickup></EstimatedArrival></ServiceSummary></TimeInTransit></RatedShipment>' +
          '<RatedShipment><TotalCharges><MonetaryValue>30.00</MonetaryValue></TotalCharges><TimeInTransit><ServiceSummary><Service><Description>UPS 2nd Day Air</Description></Service><EstimatedArrival><Arrival><Date>20250103</Date><Time>103000</Time></Arrival></EstimatedArrival></ServiceSummary></TimeInTransit></RatedShipment>',
        'RatingServiceSelectionResponse',
      ),
    });
    const rates = await new UpsClient().getRate('30301', '78701', 2.5, '6', '8', '10');
    expect(rates).toEqual([
      { serviceType: 'UPS Ground', amount: 12.34, deliveryDate: '20250104 - 230000' },
      { serviceType: 'UPS 2nd Day Air', amount: 30, deliveryDate: '20250103 - 103000' },
    ]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe('https://onlinetools.ups.com/ups.app/xml/Rate');
    expect(fetched[0].method).toBe('POST');
    expect(fetched[0].headers).toEqual({ 'Content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'Accept-Charset': 'UTF-8' });
    expect(fetched[0].body).toBe(
      ACCESS +
        `<?xml version="1.0"?>
<RatingServiceSelectionRequest xml:lang="en-US">
  <Request>
    <TransactionReference/>
    <RequestAction>Rate</RequestAction>
    <RequestOption>Shoptimeintransit</RequestOption>
  </Request>
  <PickupType>
    <Code>01</Code>
    <Description/>
  </PickupType>
  <Shipment>
    <Service>
      <Code>03</Code>
      <Description/>
    </Service>
    <Shipper>
      <Address>
        <PostalCode>30301</PostalCode>
      </Address>
    </Shipper>
    <ShipFrom>
      <Address>
        <PostalCode>30301</PostalCode>
      </Address>
    </ShipFrom>
    <ShipTo>
      <CompanyName>Test Ship To</CompanyName>
      <AttentionName/>
      <Address>
        <PostalCode>78701</PostalCode>
      </Address>
    </ShipTo>
    <Package>
      <PackagingType>
        <Code>02</Code>
        <Description/>
      </PackagingType>
      <PackageWeight>
        <Weight>2.5</Weight>
        <UnitOfMeasurement>
          <Code>LBS</Code>
          <Description/>
        </UnitOfMeasurement>
      </PackageWeight>
      <Dimensions>
        <Length>10</Length>
        <Height>6</Height>
        <Width>8</Width>
        <UnitOfMeasurement>
          <Code>IN</Code>
          <Description/>
        </UnitOfMeasurement>
      </Dimensions>
      <PackageServiceOptions/>
    </Package>
    <ShipmentServiceOptions/>
    <DeliveryTimeInformation>
      <PackageBillType>03</PackageBillType>
    </DeliveryTimeInformation>
  </Shipment>
</RatingServiceSelectionRequest>
`,
    );
  });

  it('a single RatedShipment is handled; no RatedShipment -> []', async () => {
    stubFetch({
      '/Rate': upsOk('<RatedShipment><TotalCharges><MonetaryValue>5</MonetaryValue></TotalCharges><TimeInTransit><ServiceSummary><Service><Description>G</Description></Service><EstimatedArrival><Arrival><Date>1</Date><Time>2</Time></Arrival></EstimatedArrival></ServiceSummary></TimeInTransit></RatedShipment>'),
    });
    expect(await new UpsClient().getRate('1', '2', 1, 1, 1, 1)).toEqual([{ serviceType: 'G', amount: 5, deliveryDate: '1 - 2' }]);
    stubFetch({ '/Rate': upsOk('') });
    expect(await new UpsClient().getRate('1', '2', 1, 1, 1, 1)).toEqual([]);
  });

  it('a UPS error reply throws Failure: <desc> (<code>) (the PHP did not catch it)', async () => {
    stubFetch({ '/Rate': upsErr('111210', 'The requested service is unavailable') });
    await expect(new UpsClient().getRate('1', '2', 1, 1, 1, 1)).rejects.toThrow('Failure: The requested service is unavailable (111210)');
  });

  it('UPS_SANDBOX=true uses the integration host; an HTTP error is a Failure', async () => {
    process.env.UPS_SANDBOX = 'true';
    const fetched = stubFetch({ '/Rate': upsOk('') });
    await new UpsClient().getRate('1', '2', 1, 1, 1, 1);
    expect(fetched[0].url).toBe('https://wwwcie.ups.com/ups.app/xml/Rate');
    vi.stubGlobal('fetch', async () => new Response('', { status: 500, statusText: 'Server Error' }));
    await expect(new UpsClient().getRate('1', '2', 1, 1, 1, 1)).rejects.toThrow('Failure: 500 Server Error');
  });
});

describe('UpsClient.validateAddress', () => {
  it('posts an XAV AddressValidationRequest and returns the validated address as json_encode would', async () => {
    const fetched = stubFetch({
      '/XAV': upsOk(
        '<ValidAddressIndicator/><AddressKeyFormat><AddressLine>1 MAIN ST</AddressLine><AddressLine>APT 2</AddressLine><PoliticalDivision2>AUSTIN</PoliticalDivision2><PoliticalDivision1>TX</PoliticalDivision1><PostcodePrimaryLow>78701</PostcodePrimaryLow><PostcodeExtendedLow>1234</PostcodeExtendedLow><Region>AUSTIN TX 78701-1234</Region><CountryCode>US</CountryCode></AddressKeyFormat>',
        'AddressValidationResponse',
      ),
    });
    const result = await new UpsClient().validateAddress(['1 Main & Co', 'Apt 2'], 'Austin', 'TX', '78701');
    expect(result).toEqual({
      isValid: true,
      validAddress: {
        addressClassification: null,
        consigneeName: '',
        buildingName: '',
        addressLine: '1 MAIN ST',
        addressLine2: 'APT 2',
        addressLine3: null,
        region: 'AUSTIN TX 78701-1234',
        politicalDivision2: 'AUSTIN',
        politicalDivision1: 'TX',
        postcodePrimaryLow: '78701',
        postcodeExtendedLow: '1234',
        urbanization: '',
        countryCode: 'US',
      },
    });
    expect(fetched[0].url).toBe('https://onlinetools.ups.com/ups.app/xml/XAV');
    expect(fetched[0].body).toBe(
      ACCESS +
        `<?xml version="1.0"?>
<AddressValidationRequest xml:lang="en-US">
  <Request>
    <TransactionReference/>
    <RequestAction>XAV</RequestAction>
    <RequestOption>1</RequestOption>
  </Request>
  <MaximumListSize>15</MaximumListSize>
  <AddressKeyFormat>
    <ConsigneeName>Test Test</ConsigneeName>
    <BuildingName>Test</BuildingName>
    <AddressLine>1 Main &amp; Co</AddressLine>
    <AddressLine>Apt 2</AddressLine>
    <PoliticalDivision1>TX</PoliticalDivision1>
    <PoliticalDivision2>Austin</PoliticalDivision2>
    <CountryCode>US</CountryCode>
    <PostcodePrimaryLow>78701</PostcodePrimaryLow>
  </AddressKeyFormat>
</AddressValidationRequest>
`,
    );
  });

  it('no ValidAddressIndicator -> { isValid: false }; a single address line sends only one AddressLine', async () => {
    const fetched = stubFetch({ '/XAV': upsOk('<NoCandidatesIndicator/>', 'AddressValidationResponse') });
    expect(await new UpsClient().validateAddress(['9 Nowhere'], 'X', 'GA', '00000')).toEqual({ isValid: false });
    expect(fetched[0].body.match(/<AddressLine>/g)).toHaveLength(1);
  });
});

const GIF_GRAPHIC = async () =>
  (await sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } }).gif().toBuffer()).toString('base64');

describe('UpsClient.getLabel', () => {
  const ship = (u: UpsClient, orderId: string, po: string, service: string, thirdParty = false) =>
    u.getLabel(orderId, po, warehouse, service, 10, 8, 6, 2.5, 'Bob', '5559999999', ['1 Main', ''], 'Austin', 'TX', '78701', 'US', thirdParty);

  it('ShipConfirm then ShipAccept; label GIF rotated 90deg onto the labels disk; tracking + netcharge returned', async () => {
    const graphic = await GIF_GRAPHIC();
    const fetched = stubFetch({
      '/ShipConfirm': upsOk('<ShipmentDigest>DIGEST123</ShipmentDigest>', 'ShipmentConfirmResponse'),
      '/ShipAccept': upsOk(
        `<ShipmentResults><ShipmentIdentificationNumber>1ZTRACK</ShipmentIdentificationNumber><NegotiatedRates><NetSummaryCharges><GrandTotal><CurrencyCode>USD</CurrencyCode><MonetaryValue>9.87</MonetaryValue></GrandTotal></NetSummaryCharges></NegotiatedRates><PackageResults><TrackingNumber>1ZTRACK</TrackingNumber><LabelImage><LabelImageFormat><Code>GIF</Code></LabelImageFormat><GraphicImage>${graphic}</GraphicImage></LabelImage></PackageResults></ShipmentResults>`,
        'ShipmentAcceptResponse',
      ),
    });
    const label = await ship(new UpsClient(), 'L02-UPS', 'PO5', '');
    expect(label).toEqual({ tracking: '1ZTRACK', label: `${storageDir}/app/public/labels/labels/L02-UPS.gif`, netcharge: '9.87' });
    const written = readFileSync(label!.label);
    expect(written.subarray(0, 3).toString()).toBe('GIF');
    const meta = await sharp(written).metadata();
    expect([meta.width, meta.height]).toEqual([4, 6]);
    expect(statSync(label!.label).mode & 0o777).toBe(0o666);

    expect(fetched.map((f) => f.url)).toEqual([
      'https://onlinetools.ups.com/ups.app/xml/ShipConfirm',
      'https://onlinetools.ups.com/ups.app/xml/ShipAccept',
    ]);
    expect(fetched[0].body).toBe(
      ACCESS +
        `<?xml version="1.0"?>
<ShipmentConfirmRequest>
  <Request>
    <TransactionReference/>
    <RequestAction>ShipConfirm</RequestAction>
    <RequestOption>validate</RequestOption>
  </Request>
  <Shipment>
    <Shipper>
      <Name>Angel Isabella</Name>
      <AttentionName>Angel Isabella</AttentionName>
      <ShipperNumber>727961</ShipperNumber>
      <PhoneNumber>5551234567</PhoneNumber>
      <Address>
        <AddressLine1>1 Dock Rd</AddressLine1>
        <AddressLine2>Bldg 2</AddressLine2>
        <City>Atlanta</City>
        <StateProvinceCode>GA</StateProvinceCode>
        <PostalCode>30301</PostalCode>
        <CountryCode>US</CountryCode>
      </Address>
    </Shipper>
    <ShipTo>
      <CompanyName>Bob</CompanyName>
      <AttentionName>Bob</AttentionName>
      <PhoneNumber>5559999999</PhoneNumber>
      <Address>
        <AddressLine1>1 Main</AddressLine1>
        <City>Austin</City>
        <StateProvinceCode>TX</StateProvinceCode>
        <PostalCode>78701</PostalCode>
        <CountryCode>US</CountryCode>
      </Address>
    </ShipTo>
    <ShipFrom>
      <CompanyName>Angel Isabella</CompanyName>
      <AttentionName>Angel Isabella</AttentionName>
      <PhoneNumber>5551234567</PhoneNumber>
      <Address>
        <AddressLine1>1 Dock Rd</AddressLine1>
        <AddressLine2>Bldg 2</AddressLine2>
        <City>Atlanta</City>
        <StateProvinceCode>GA</StateProvinceCode>
        <PostalCode>30301</PostalCode>
        <CountryCode>US</CountryCode>
      </Address>
    </ShipFrom>
    <PaymentInformation>
      <Prepaid>
        <BillShipper>
          <AccountNumber>727961</AccountNumber>
        </BillShipper>
      </Prepaid>
    </PaymentInformation>
    <Service>
      <Code>03</Code>
      <Description>UPS Ground</Description>
    </Service>
    <RateInformation>
      <NegotiatedRatesIndicator/>
    </RateInformation>
    <Package>
      <PackagingType>
        <Code>02</Code>
        <Description/>
      </PackagingType>
      <PackageWeight>
        <Weight>2.5</Weight>
        <UnitOfMeasurement>
          <Code>LBS</Code>
          <Description/>
        </UnitOfMeasurement>
      </PackageWeight>
      <Dimensions>
        <Length>10</Length>
        <Height>6</Height>
        <Width>8</Width>
        <UnitOfMeasurement>
          <Code>IN</Code>
          <Description/>
        </UnitOfMeasurement>
      </Dimensions>
      <PackageServiceOptions/>
      <ReferenceNumber>
        <Code>IK</Code>
        <Value>L02-UPS</Value>
      </ReferenceNumber>
      <ReferenceNumber>
        <Code>PO</Code>
        <Value>PO5</Value>
      </ReferenceNumber>
    </Package>
    <ShipmentServiceOptions/>
  </Shipment>
  <LabelSpecification>
    <LabelPrintMethod>
      <Code>GIF</Code>
    </LabelPrintMethod>
    <LabelImageFormat>
      <Code>GIF</Code>
    </LabelImageFormat>
  </LabelSpecification>
</ShipmentConfirmRequest>
`,
    );
    expect(fetched[1].body).toBe(
      ACCESS +
        `<?xml version="1.0"?>
<ShipmentAcceptRequest>
  <Request>
    <TransactionReference/>
    <RequestAction>ShipAccept</RequestAction>
  </Request>
  <ShipmentDigest>DIGEST123</ShipmentDigest>
</ShipmentAcceptRequest>
`,
    );
  });

  it('third-party billing and an explicit service code', async () => {
    const graphic = await GIF_GRAPHIC();
    const fetched = stubFetch({
      '/ShipConfirm': upsOk('<ShipmentDigest>D</ShipmentDigest>'),
      '/ShipAccept': upsOk(`<ShipmentResults><ShipmentIdentificationNumber>1Z2</ShipmentIdentificationNumber><PackageResults><LabelImage><GraphicImage>${graphic}</GraphicImage></LabelImage></PackageResults></ShipmentResults>`),
    });
    const label = await ship(new UpsClient(), 'L02-3P', '', '02', true);
    expect(label).toEqual({ tracking: '1Z2', label: `${storageDir}/app/public/labels/labels/L02-3P.gif` });
    expect(fetched[0].body).toContain(`<PaymentInformation>
      <BillThirdParty>
        <BillThirdPartyShipper>
          <AccountNumber>X3684X</AccountNumber>
          <ThirdParty>
            <Address>
              <PostalCode>30301</PostalCode>
              <CountryCode>US</CountryCode>
            </Address>
          </ThirdParty>
        </BillThirdPartyShipper>
      </BillThirdParty>
    </PaymentInformation>
    <Service>
      <Code>02</Code>
      <Description>UPS Second Day Air</Description>
    </Service>`);
    expect(fetched[0].body).not.toContain('<Code>PO</Code>');
  });

  it('a UPS error, or DRY_RUN=1, returns null and never reaches ShipAccept / the network', async () => {
    const fetched = stubFetch({ '/ShipConfirm': upsErr('120100', 'Missing or invalid shipper number') });
    expect(await ship(new UpsClient(), 'L02-ERR', '', 'GROUND')).toBeNull();
    expect(fetched).toHaveLength(1);

    process.env.DRY_RUN = '1';
    const dry = stubFetch({});
    expect(await ship(new UpsClient(), 'L02-DRY', '', '')).toBeNull();
    expect(await new UpsClient().deleteShipment('1ZABC')).toBeNull();
    expect(dry).toEqual([]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('[DRY_RUN] UPS /ShipConfirm not sent'), expect.any(String));
  });

  it('an unknown service code is an error outside the try (undefined index), like PHP', async () => {
    stubFetch({});
    await expect(ship(new UpsClient(), 'L02-BAD', '', '99')).rejects.toThrow('Undefined index: 99');
  });
});

describe('UpsClient.deleteShipment', () => {
  it('posts VoidShipmentRequest with the upper-cased id and returns the reply without Response', async () => {
    const fetched = stubFetch({
      '/Void': upsOk('<Status><StatusType><Code>1</Code><Description>Success</Description></StatusType><StatusCode><Code>1</Code><Description>Success</Description></StatusCode></Status>', 'VoidShipmentResponse'),
    });
    const reply = await new UpsClient().deleteShipment('1zabc123');
    expect(reply).toEqual({
      Status: { StatusType: { Code: '1', Description: 'Success' }, StatusCode: { Code: '1', Description: 'Success' } },
    });
    expect(fetched[0].url).toBe('https://onlinetools.ups.com/ups.app/xml/Void');
    expect(fetched[0].body).toBe(
      ACCESS +
        `<?xml version="1.0"?>
<VoidShipmentRequest>
  <Request>
    <TransactionReference/>
    <RequestAction>1</RequestAction>
  </Request>
  <ExpandedVoidShipment>
    <ShipmentIdentificationNumber>1ZABC123</ShipmentIdentificationNumber>
  </ExpandedVoidShipment>
</VoidShipmentRequest>
`,
    );
  });

  it('returns null when UPS rejects the void', async () => {
    stubFetch({ '/Void': upsErr('190117', 'Invalid tracking number') });
    expect(await new UpsClient().deleteShipment('1ZNOPE')).toBeNull();
  });
});
