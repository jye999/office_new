// L03: App\Libraries\Frayun + Usps ports. Nothing reaches Frayun/USPS: Frayun is mocked at
// setFrayunTransportForTests (plus one real-WSDL encode pass against a loopback HTTP server), USPS at
// setUspsTransportForTests.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as soap from 'soap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nowDb } from '../src/db.js';
import { Frayun, FrayunFault, setFrayunTransportForTests } from '../src/lib/frayun.js';
import { setUspsTransportForTests, Usps } from '../src/lib/usps.js';

type Call = { operation: string; params: any };
let calls: Call[];
let replies: Record<string, any>;

beforeEach(() => {
  Object.assign(process.env, {
    FRAYUN_USERNAME: 'fuser',
    FRAYUN_PASSWORD: 'fpass',
    FRAYUN_SENDTYPE: 'DPD-SP',
    FRAYUN_ADDRESS_NO: '99',
    USPS_URL: 'https://secure.shippingapis.com/ShippingAPI.dll',
    USPS_USERNAME: 'uspsuser',
  });
  delete process.env.DRY_RUN;
  calls = [];
  replies = {};
  setFrayunTransportForTests(async (operation, params) => {
    calls.push({ operation, params });
    const reply = replies[operation];
    if (reply instanceof Error) throw reply;
    return reply ?? {};
  });
});
afterEach(() => {
  setFrayunTransportForTests(null);
  setUspsTransportForTests(null);
  delete process.env.DRY_RUN;
  vi.restoreAllMocks();
});

const toAddress = { Name: 'C D', Company: 'Co', Phone: '555', Address1: '1 Main', Address2: 'Apt 2', City: 'Cumming', State: 'GA', ZIPCode: '30041' };
const fromAddress = { Company: 'Angel Isabella, LLC' };

describe('Frayun.getStateAbbr', () => {
  it('maps names case-insensitively; unknown is undefined like the PHP array miss', () => {
    expect(Frayun.getStateAbbr('georgia')).toBe('GA');
    expect(Frayun.getStateAbbr('New York')).toBe('NY');
    expect(Frayun.getStateAbbr('Yukon Territory')).toBe('YT');
    expect(Frayun.getStateAbbr('Nowhere')).toBeUndefined();
    expect(Frayun.getStateAbbr('toString')).toBeUndefined();
  });
});

describe('Frayun.getBalance / downloadLabel', () => {
  it('GetBalance sends credentials and returns the result as a string', async () => {
    replies.GetBalance = { GetBalanceResult: '[{"Balance":12.5}]' };
    expect(await new Frayun().getBalance()).toBe('[{"Balance":12.5}]');
    expect(calls).toEqual([{ operation: 'GetBalance', params: { UserName: 'fuser', PassWord: 'fpass' } }]);
  });

  it('GetPdfPre sends DpdNo and returns GetPdfPreResult (a read: still sent under DRY_RUN)', async () => {
    process.env.DRY_RUN = '1';
    replies.GetPdfPre = { GetPdfPreResult: '[{"Pdf":"abc"}]' };
    expect(await new Frayun().downloadLabel('09900064265081')).toBe('[{"Pdf":"abc"}]');
    expect(calls).toEqual([{ operation: 'GetPdfPre', params: { UserName: 'fuser', PassWord: 'fpass', DpdNo: '09900064265081' } }]);
  });

  it('propagates SOAP faults (the PHP callers never catch them)', async () => {
    replies.GetBalance = new FrayunFault('bad login');
    await expect(new Frayun().getBalance()).rejects.toMatchObject({ faultstring: 'bad login' });
  });
});

describe('Frayun.buyLabel', () => {
  const stamp = () => nowDb().replace(/\D/g, '');

  it('sends CreatePreToJson with the PHP JsonData template (default product)', async () => {
    replies.CreatePreToJson = { CreatePreToJsonResult: '[{"DpdNo":"1"}]' };
    const r = await new Frayun().buyLabel(' 114-1 ', fromAddress, toAddress, 'REF1', '2026-10-23', 0.15, 20, 10, 15);
    expect(r).toBe('[{"DpdNo":"1"}]');
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('CreatePreToJson');
    const { JsonData, ...rest } = calls[0].params;
    expect(rest).toEqual({ UserName: 'fuser', PassWord: 'fpass' });
    // ClientNumber uses the raw orderId (untrimmed) + date("YmdHis"); product names use the trimmed id
    expect(JsonData).toMatch(/^\n {8}\{\n {12}"ClientNumber":" 114-1 \*\d{14}",\n\n/);
    expect(JsonData).toContain(`"ClientNumber":" 114-1 *${stamp().slice(0, 10)}`);
    expect(JsonData).toContain('"ReceiveAddress":"1 Main Apt 2",');
    expect(JsonData).toContain('"SendType":"DPD-SP",');
    expect(JsonData).toContain('"ActualWeight":0.15,            \n');
    expect(JsonData).toContain('"VolumeHeight":10,\n            "VolumeLength":20,\n            "VolumeWidth":15,\n            "VolumeWeight":0.15,');
    expect(JsonData).toContain('"SerialNumber":"99",');
    expect(JsonData).toContain('"Ref":"REF1",');
    expect(JsonData).toContain('"IsScanForm":0,\n            "ShipDate":"2026-10-23",');
    expect(JsonData).toContain('"ProduceNameCN":"order 114-1"');
    expect(JsonData).toContain('"Sku":"114-1"');
    expect(JsonData).toContain('"Weight":"0.15"');
    // the whole thing is valid JSON for these inputs
    const parsed = JSON.parse(JsonData);
    expect(parsed.JsonProductInfo).toEqual([
      { ProduceNameCN: 'order 114-1', ProduceNameEN: 'order 114-1', USD: '200', SalePrice: '200', Packages: '1', Sku: '114-1', Weight: '0.15' },
    ]);
    expect(parsed.ReceiveCountry).toBe('United States of America');
  });

  it('uses json_encode(products) when a non-empty array/assoc is given, empty values become ""', async () => {
    replies.CreatePreToJson = { CreatePreToJsonResult: '[]' };
    const products = [{ Sku: 'A/B', ProduceNameEN: 'é' }];
    await new Frayun().buyLabel('9', fromAddress, {}, null, '2026-10-23', 1, 2, 3, 4, products);
    const parsed = JSON.parse(calls[0].params.JsonData);
    expect(calls[0].params.JsonData).toContain('"JsonProductInfo":[{"Sku":"A\\/B","ProduceNameEN":"\\u00e9"}]');
    expect(parsed.JsonProductInfo).toEqual(products);
    expect(parsed.ReceiveName).toBe('');
    expect(parsed.ReceiveAddress).toBe(' ');
    expect(parsed.Ref).toBe('');
    // empty products falls back to the default one
    await new Frayun().buyLabel('9', fromAddress, toAddress, 'r', 'd', 1, 2, 3, 4, []);
    expect(JSON.parse(calls[1].params.JsonData).JsonProductInfo[0].Sku).toBe('9');
  });

  it('DRY_RUN=1 never reaches the transport and logs without credentials', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(new Frayun().buyLabel('1', fromAddress, toAddress, 'r', 'd', 1, 2, 3, 4)).rejects.toMatchObject({
      faultstring: 'DRY_RUN: Frayun CreatePreToJson not sent',
    });
    expect(calls).toEqual([]);
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.stringify(info.mock.calls)).not.toContain('fpass');
    expect(String(info.mock.calls[0][0])).toContain('[DRY_RUN] Frayun CreatePreToJson not sent');
  });

  it('real WSDL encodes CreatePreToJson as UserName/PassWord/JsonData (loopback, nothing external)', async () => {
    let body = '';
    let action = '';
    const server = createServer((req, res) => {
      action = String(req.headers.soapaction);
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'text/xml');
        res.end(
          '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
            '<CreatePreToJsonResponse xmlns="http://tempuri.org/"><CreatePreToJsonResult>[]</CreatePreToJsonResult></CreatePreToJsonResponse>' +
            '</soap:Body></soap:Envelope>',
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      replies.CreatePreToJson = { CreatePreToJsonResult: '[]' };
      await new Frayun().buyLabel('7', fromAddress, toAddress, 'r', 'd', 1, 2, 3, 4);
      const client = await soap.createClientAsync(new URL('../config/frayun.xml', import.meta.url).pathname, {
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/Service.asmx`,
      });
      const [result] = await client.CreatePreToJsonAsync(calls[0].params);
      expect(result).toEqual({ CreatePreToJsonResult: '[]' });
      expect(action).toContain('http://tempuri.org/CreatePreToJson');
      expect(body).toMatch(/<UserName>fuser<\/UserName><PassWord>fpass<\/PassWord><JsonData>[\s\S]*&quot;ClientNumber&quot;:&quot;7\*/);
    } finally {
      server.close();
    }
  });
});

describe('Usps.getRate', () => {
  const run = async (serviceType: string) => {
    const urls: string[] = [];
    setUspsTransportForTests(async (url) => {
      urls.push(url);
      return '<?xml version="1.0"?><RateV4Response><Package ID="1ST"><ZipOrigination>30041</ZipOrigination><Zone>1</Zone><Postage CLASSID="1"><Rate>4.50</Rate></Postage></Package></RateV4Response>';
    });
    const r = await new Usps().getRate('30041', '90278', serviceType, 0, 3, 10, 6, 2);
    return { urls, r };
  };
  const decode = (url: string) => {
    const [base, query] = url.split('?');
    const params = new URLSearchParams(query);
    return { base, api: params.get('API'), xml: params.get('XML') };
  };

  it('GETs USPS_URL?API=RateV4&XML=urlencode("XML=<RateV4Request ...>") for PRIORITY MAIL', async () => {
    const { urls } = await run('Priority Mail');
    const { base, api, xml } = decode(urls[0]);
    expect(urls).toHaveLength(1);
    expect(base).toBe('https://secure.shippingapis.com/ShippingAPI.dll');
    expect(api).toBe('RateV4');
    expect(xml).toBe(
      'XML=<RateV4Request USERID="uspsuser"><Revision>2</Revision><Package ID="1ST"><Service>PRIORITY MAIL</Service>' +
        '<ZipOrigination>30041</ZipOrigination><ZipDestination>90278</ZipDestination><Pounds>0</Pounds><Ounces>3</Ounces>' +
        '<Container></Container><Width>6</Width><Length>10</Length><Height>2</Height><Girth></Girth><Machinable>false</Machinable>' +
        '</Package></RateV4Request>',
    );
    // PHP urlencode: spaces are '+', '<' is %3C
    expect(urls[0]).toContain('XML=XML%3D%3CRateV4Request+USERID%3D%22uspsuser%22%3E');
  });

  it('FIRST CLASS uses FIRST CLASS COMMERCIAL + FirstClassMailType', async () => {
    const { urls } = await run('FIRST CLASS');
    expect(decode(urls[0]).xml).toContain(
      '<Service>FIRST CLASS COMMERCIAL</Service><FirstClassMailType>Package Service</FirstClassMailType><ZipOrigination>',
    );
  });

  it('returns the parsed response like SimpleXML', async () => {
    const { r } = await run('FIRST CLASS');
    expect(r).toMatchObject({ Package: { Zone: '1', Postage: { Rate: '4.50' } } });
  });

  it('non-XML body -> false (simplexml_load_string failure)', async () => {
    setUspsTransportForTests(async () => 'Service Unavailable');
    expect(await new Usps().getRate(1, 2, 'FIRST CLASS', 0, 1, 1, 1, 1)).toBe(false);
  });
});
