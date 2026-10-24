// L01: App\Libraries\Stamps port. The SOAP transport is mocked (setStampsTransportForTests);
// the pruning test builds a client from the real WSDL but captures the XML instead of sending it.

import * as soap from 'soap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowDb } from '../src/db.js';
import { pruneToSchema, setStampsTransportForTests, Stamps, StampsFault } from '../src/lib/stamps.js';

type Call = { operation: string; params: any };
let calls: Call[];
let replies: Record<string, any>;

const credentials = { IntegrationID: 'int-id', Username: 'user', Password: 'pass' };
const from = { FullName: 'A B', ZIPCode: '30040', Country: 'US' };
const to = { FullName: 'C D', Address1: '1 Main', City: 'X', State: 'GA', ZIPCode: '30301', Country: 'US' };

beforeEach(() => {
  process.env.STAMPS_INTEGRATIONID = 'int-id';
  process.env.STAMPS_USERNAME = 'user';
  process.env.STAMPS_PASSWORD = 'pass';
  delete process.env.DRY_RUN;
  calls = [];
  replies = {};
  setStampsTransportForTests(async (operation, params) => {
    calls.push({ operation, params });
    const reply = replies[operation];
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(params) : (reply ?? {});
  });
});
afterEach(() => {
  setStampsTransportForTests(null);
  delete process.env.DRY_RUN;
});

describe('getStateAbbr', () => {
  it('maps names case-insensitively and passes through unknowns upper-cased', () => {
    expect(Stamps.getStateAbbr('georgia')).toBe('GA');
    expect(Stamps.getStateAbbr('New York')).toBe('NY');
    expect(Stamps.getStateAbbr('Yukon Territory')).toBe('YT');
    expect(Stamps.getStateAbbr('ga')).toBe('GA');
    expect(Stamps.getStateAbbr('toString')).toBe('TOSTRING');
  });
});

describe('getCleanse / cleaseAddress', () => {
  it('sends Credentials + Address; US keeps ZIPCode', async () => {
    replies.CleanseAddress = { AddressMatch: true, CityStateZipOK: true, Address: { City: 'X' } };
    const r = await new Stamps().getCleanse(to);
    expect(calls).toEqual([{ operation: 'CleanseAddress', params: { Credentials: credentials, Address: to } }]);
    expect(r).toEqual({ success: 'true', response: replies.CleanseAddress });
  });

  it('non-US moves ZIPCode to PostalCode', async () => {
    replies.CleanseAddress = { AddressMatch: true, CityStateZipOK: true };
    await new Stamps().getCleanse({ ...to, Country: 'CA', ZIPCode: 'K1A 0B1' });
    expect(calls[0].params.Address.PostalCode).toBe('K1A 0B1');
    expect(calls[0].params.Address).not.toHaveProperty('ZIPCode');
  });

  it('reports Invalid Address with the response, and a fault as message string', async () => {
    replies.CleanseAddress = { AddressMatch: false, CityStateZipOK: true };
    expect(await new Stamps().getCleanse(to)).toEqual({ success: 'false', message: 'Invalid Address', response: replies.CleanseAddress });
    replies.CleanseAddress = new StampsFault('bad zip');
    expect(await new Stamps().getCleanse(to)).toEqual({ success: 'false', message: 'bad zip' });
  });
});

describe('rate calls', () => {
  const today = () => nowDb().slice(0, 10);

  it('getRatesNoCleanse: cleanse then GetRates (USPS) with insurance + declared value', async () => {
    replies.CleanseAddress = { AddressMatch: 1, CityStateZipOK: 1, Address: { City: 'CLEAN' } };
    replies.GetRates = { Rates: { Rate: [] } };
    const r = await new Stamps().getRatesNoCleanse(to, from, 1, 2, 3, 4, 5, 'Package', 50, '20');
    expect(calls.map((c) => c.operation)).toEqual(['CleanseAddress', 'GetRates']);
    expect(calls[1].params).toEqual({
      Credentials: credentials,
      Rate: {
        From: from, To: to, ShipDate: today(), WeightLb: 1, WeightOz: 2, Length: 3, Width: 4, Height: 5,
        PackageType: 'Package', NonMachinable: false, RectangularShaped: true, InsuredValue: 50,
        AddOns: { AddOn: { Amount: 50, AddOnType: 'US-A-INS' } }, DeclaredValue: '20',
      },
      Carrier: 'USPS',
    });
    expect(r).toEqual({ success: 'true', response: replies.GetRates, Address: { City: 'CLEAN' } });
  });

  it('getRatesNoCleanse: non-numeric declared value -> 0 (omitted), no insurance -> InsuredValue 0', async () => {
    replies.CleanseAddress = { AddressMatch: 1, CityStateZipOK: 1 };
    await new Stamps().getRatesNoCleanse(to, from, 1, 0, 1, 1, 1, 'Package', '', 'abc');
    expect(calls[1].params.Rate.InsuredValue).toBe(0);
    expect(calls[1].params.Rate).not.toHaveProperty('AddOns');
    expect(calls[1].params.Rate).not.toHaveProperty('DeclaredValue');
  });

  it('getRatesNoCleanse: GetRates fault -> failure array; cleanse fault + good rates -> throws (PHP ErrorException)', async () => {
    replies.CleanseAddress = { AddressMatch: 1, CityStateZipOK: 1 };
    replies.GetRates = new StampsFault('no rates');
    expect(await new Stamps().getRatesNoCleanse(to, from, 1, 0, 1, 1, 1, 'Package', 0, 0)).toEqual({
      success: 'false', step: 'GetRates failed', message: 'no rates',
    });
    replies.CleanseAddress = new StampsFault('cleanse down');
    replies.GetRates = {};
    await expect(new Stamps().getRatesNoCleanse(to, from, 1, 0, 1, 1, 1, 'Package', 0, 0)).rejects.toThrow('Undefined index');
  });

  it('getUpsRates: Carrier UPS, CAR-A-INS add-on, Package type', async () => {
    replies.GetRates = { Rates: {} };
    const r = await new Stamps().getUpsRates(to, from, 2, 0, 9, 9, 9, 100, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.Carrier).toBe('UPS');
    expect(calls[0].params.Rate).toMatchObject({
      PackageType: 'Package', InsuredValue: 100, AddOns: { AddOn: { Amount: 100, AddOnType: 'CAR-A-INS' } },
    });
    expect(calls[0].params.Rate).not.toHaveProperty('DeclaredValue');
    expect(r).toEqual({ success: 'true', response: replies.GetRates });
    replies.GetRates = new StampsFault('ups down');
    expect(await new Stamps().getUpsRates(to, from, 2, 0, 9, 9, 9, 0, 0)).toEqual({
      success: 'false', step: 'UPS GetRates failed', message: 'ups down',
    });
  });

  it('getRatesOnlyNoCleanse: no cleanse, no Carrier, raw response; fault returns the failure array', async () => {
    replies.GetRates = { Rates: { Rate: [{ Amount: '3.00' }] } };
    expect(await new Stamps().getRatesOnlyNoCleanse(to, from, 1, 0, 1, 1, 1, 'Package', 0, 0)).toBe(replies.GetRates);
    expect(calls.map((c) => c.operation)).toEqual(['GetRates']);
    expect(calls[0].params).not.toHaveProperty('Carrier');
    replies.GetRates = new StampsFault('boom');
    expect(await new Stamps().getRatesOnlyNoCleanse(to, from, 1, 0, 1, 1, 1, 'Package', 0, 0)).toEqual({
      success: 'false', step: 'GetRates failed', message: 'boom',
    });
  });
});

describe('buyLabel (CreateIndicium)', () => {
  const encode = (rate: object) => encodeURIComponent(JSON.stringify(rate));
  const uspsRate = {
    ServiceType: 'US-PM', Amount: '7.00', Surcharges: { x: 1 }, surcharges: { y: 1 },
    AddOns: { AddOnV20: [
      { AddOnType: 'SC-A-HP', Amount: 0 },
      { AddOnType: 'US-A-INS', Amount: '1.50' },
      { AddOnType: 'US-A-INS', Amount: 'n/a' },
      { AddOnType: 'US-A-SC', Amount: 2 },
      { AddOnType: 'US-A-RD', Amount: 3 },
    ] },
  };

  it('USPS: keeps HP + numeric INS, SC only when needSignature is true; strips Surcharges', async () => {
    replies.CreateIndicium = { StampsTxID: 'tx1' };
    const r = await new Stamps().buyLabel(null, encode(uspsRate), from, to, 123, []);
    const p = calls[0].params;
    expect(calls[0].operation).toBe('CreateIndicium');
    expect(p.Credentials).toEqual(credentials);
    expect(p.IntegratorTxID).toMatch(/^[0-9a-zA-Z]{10}$/);
    expect(p.Rate).toEqual({
      ServiceType: 'US-PM', Amount: '7.00', InsuredValue: 0,
      AddOns: [{ AddOnType: 'SC-A-HP', Amount: 0 }, { AddOnType: 'US-A-INS', Amount: '1.50' }],
    });
    expect(p.From).toBe(from);
    expect(p.To).toEqual(to);
    expect(p.memo).toBe('123');
    expect(p).not.toHaveProperty('Customs');
    expect(r).toEqual({ success: 'true', response: { StampsTxID: 'tx1' } });

    await new Stamps().buyLabel(null, encode(uspsRate), from, to, 'm', [], 'true');
    expect(calls[1].params.Rate.AddOns.map((a: any) => a.AddOnType)).toEqual(['SC-A-HP', 'US-A-INS', 'US-A-SC']);
  });

  it('single (non-list) AddOnV20 is wrapped; Customs sent only when non-empty; URL "+" decodes to space', async () => {
    const rate = { ServiceType: 'US-FC', AddOns: { AddOnV20: { AddOnType: 'US-A-INS', Amount: 5 } } };
    await new Stamps().buyLabel(null, encode(rate).replace(/%20/g, '+'), from, to, null, { ContentType: 'Gift' });
    expect(calls[0].params.Rate.AddOns).toEqual([{ AddOnType: 'US-A-INS', Amount: 5 }]);
    expect(calls[0].params.Customs).toEqual({ ContentType: 'Gift' });
    expect(calls[0].params.memo).toBe('');
  });

  it('UPS: only CAR-A-INS (+ signature types when needed), default phone number', async () => {
    const rate = {
      ServiceType: 'UPS-GROUND',
      AddOns: { AddOnV20: [
        { AddOnType: 'CAR-A-RES', Amount: 4 },
        { AddOnType: 'CAR-A-INS', Amount: 9 },
        { AddOnType: 'CAR-A-ASR', Amount: 5, Extra: 1 },
        { AddOnType: 'SUR-X', Amount: 1 },
      ] },
    };
    await new Stamps().buyLabel(null, encode(rate), from, { ...to, PhoneNumber: '  ' }, 'm', []);
    expect(calls[0].params.To.PhoneNumber).toBe('678-999-6232');
    expect(calls[0].params.Rate.AddOns).toEqual([{ AddOnType: 'CAR-A-INS', Amount: 9 }]);
    await new Stamps().buyLabel(null, encode(rate), from, { ...to, PhoneNumber: '555' }, 'm', [], true);
    expect(calls[1].params.To.PhoneNumber).toBe('555');
    expect(calls[1].params.Rate.AddOns).toEqual([{ AddOnType: 'CAR-A-INS', Amount: 9 }, { AddOnType: 'CAR-A-ASR', Amount: 5 }]);
  });

  it('strips /* */ and " //" comments before decoding', async () => {
    await new Stamps().buyLabel(null, encode({ a: 1 }).replace('%7B', '%7B%2F*c*%2F'), from, to, 'm', []);
    expect(calls[0].params.Rate).toEqual({ a: 1, InsuredValue: 0, AddOns: [] });
  });

  it('fault -> failure array; out-of-sync fault retries once and returns the retry', async () => {
    replies.CreateIndicium = new StampsFault('Insufficient funds');
    expect(await new Stamps().buyLabel(null, encode(uspsRate), from, to, 'm', [])).toEqual({ success: 'false', message: 'Insufficient funds' });
    calls.length = 0;
    let n = 0;
    replies.CreateIndicium = () => { if (n++ === 0) throw new StampsFault('Invalid conversation token'); return { StampsTxID: 'tx2' }; };
    const r = await new Stamps().buyLabel(null, encode(uspsRate), from, to, 'm', []);
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ success: 'true', response: { StampsTxID: 'tx2' } });
  });
});

describe('other operations', () => {
  it('accountInfo / getTracking / getUrl / purchasePostage request shapes', async () => {
    replies.GetAccountInfo = { AccountInfo: {} };
    expect(await new Stamps().accountInfo()).toEqual({ success: 'true', response: replies.GetAccountInfo });
    await new Stamps().getTracking('tx9', 'ignored');
    await new Stamps().getUrl('OnlineReportingSCAN');
    await new Stamps().purchasePostage(10, 55.5);
    expect(calls).toEqual([
      { operation: 'GetAccountInfo', params: { Credentials: credentials } },
      { operation: 'TrackShipment', params: { Credentials: credentials, StampsTxID: 'tx9' } },
      { operation: 'GetURL', params: { Credentials: credentials, URLType: 'OnlineReportingSCAN', ApplicationContext: '' } },
      { operation: 'PurchasePostage', params: { Credentials: credentials, PurchaseAmount: 10, ControlTotal: 55.5 } },
    ]);
  });

  it('faults come back as { success: false, message: <fault> } with .faultstring', async () => {
    replies.GetAccountInfo = new StampsFault('auth failed');
    const r = await new Stamps().accountInfo();
    expect(r.success).toBe('false');
    expect(r.message.faultstring).toBe('auth failed');
  });

  it('cancelLabel does nothing (PHP call is commented out)', () => {
    new Stamps().cancelLabel('tx');
    expect(calls).toEqual([]);
  });

  it('printScanForm: null or non-empty list sends the ShipDate form; an empty list keeps StampsTxIDs', async () => {
    await new Stamps().printScanForm(null, from);
    await new Stamps().printScanForm(['a'], from);
    await new Stamps().printScanForm([], from);
    const day = nowDb().slice(0, 10);
    const dated = { Credentials: credentials, ShipDate: day, FromAddress: from, ImageType: 'Png', PrintInstructions: false };
    expect(calls.map((c) => c.operation)).toEqual(['CreateScanForm', 'CreateScanForm', 'CreateScanForm']);
    expect(calls[0].params).toEqual(dated);
    expect(calls[1].params).toEqual(dated);
    expect(calls[2].params).toEqual({ Credentials: credentials, StampsTxIDs: [], FromAddress: from, ImageType: 'Png', PrintInstructions: false });
  });
});

describe('DRY_RUN=1', () => {
  it('write operations are logged, never sent; reads still go out', async () => {
    process.env.DRY_RUN = '1';
    const rate = encodeURIComponent(JSON.stringify({ ServiceType: 'US-PM' }));
    const buy = await new Stamps().buyLabel(null, rate, from, to, 'm', []);
    const purchase = await new Stamps().purchasePostage(100, 1);
    const scan = await new Stamps().printScanForm(null, from);
    expect(calls).toEqual([]);
    expect(buy).toEqual({ success: 'false', message: 'DRY_RUN: Stamps CreateIndicium not sent' });
    expect(purchase.success).toBe('false');
    expect(purchase.message.faultstring).toBe('DRY_RUN: Stamps PurchasePostage not sent');
    expect(scan.message.faultstring).toBe('DRY_RUN: Stamps CreateScanForm not sent');
    await new Stamps().getTracking('tx');
    expect(calls.map((c) => c.operation)).toEqual(['TrackShipment']);
  });
});

describe('WSDL pruning (real stamps.prod.xml, XML captured not sent)', () => {
  it('drops unknown keys, maps a list to AddOnV20 and orders by schema', async () => {
    let xml = '';
    const wsdl = new URL('../config/stamps.prod.xml', import.meta.url).pathname;
    const client: any = await soap.createClientAsync(wsdl, {
      request: ((opts: any) => { xml = opts.data; return Promise.resolve({ data: '<x/>', headers: {}, status: 200 }); }) as any,
    } as any);
    const desc = client.describe().SwsimV135.SwsimV135Soap.CreateIndicium.input;
    const params = {
      memo: 'hello', Bogus: 1,
      Rate: { ShipDate: '2026-01-01', WeightLb: 1, AddOns: [{ AddOnType: 'US-A-INS', Amount: 5 }], Nope: 2 },
      Credentials: {},
    };
    await client.CreateIndiciumAsync(pruneToSchema({ ...params, Credentials: credentials }, desc)).catch(() => {});
    expect(xml).not.toContain('Bogus');
    expect(xml).not.toContain('Nope');
    expect(xml).toContain('<AddOns><AddOnV20><Amount>5</Amount><AddOnType>US-A-INS</AddOnType></AddOnV20></AddOns>');
    expect(xml.indexOf('<WeightLb>')).toBeLessThan(xml.indexOf('<ShipDate>'));
    expect(xml).toContain('<memo>hello</memo>');
    // getRatesNoCleanse's wrong 'AddOn' key is dropped just like PHP's SoapClient did
    const rates = client.describe().SwsimV135.SwsimV135Soap.GetRates.input;
    expect(pruneToSchema({ Rate: { AddOns: { AddOn: { Amount: 1 } }, InsuredValue: 1 }, Carrier: 'USPS', X: 1 }, rates)).toEqual({
      Rate: { InsuredValue: 1, AddOns: {} }, Carrier: 'USPS',
    });
  });
});

describe('real transport (no network)', () => {
  it('CreateScanForm is not in the v135 WSDL -> SoapFault "not a valid method", as in PHP', async () => {
    setStampsTransportForTests(null);
    process.env.STAMPS_MODE = 'prod';
    const r = await new Stamps().printScanForm(null, from);
    expect(r.success).toBe('false');
    expect(r.message.faultstring).toBe('Function ("CreateScanForm") is not a valid method for this service');
  });
});
