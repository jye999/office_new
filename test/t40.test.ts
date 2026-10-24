// T40: carrier routes (Stamps/Fedex/UPS/Frayun controllers). All external SOAP
// transports are stubbed; the live DB is used read-only plus temp os_trackings
// rows that are cleaned up. WRITE routes run with DRY_RUN=1 so no postage is
// bought and no write SOAP call is sent.

import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerStampsRoutes, setMassPrintQueuePushForTests } from '../src/modules/stamps/routes.js';
import { registerFedexRoutes } from '../src/modules/fedex/routes.js';
import { registerUpsRoutes } from '../src/modules/ups/routes.js';
import { registerFrayunRoutes } from '../src/modules/frayun/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { setStampsTransportForTests } from '../src/lib/stamps.js';
import { setFedexTransportForTests } from '../src/lib/fedex.js';
import { setFrayunTransportForTests } from '../src/lib/frayun.js';

let USER_ID = 0; // resolved in beforeAll: any user holding one of the route roles
const TEMP_TRACKING = 'T40TESTTRACK123';

let pushed: string[] = [];
let dryRunPrev: string | undefined;

beforeAll(async () => {
  const row = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id')
    .where('os_roles.name', 'in', ['admin', 'user', 'remote'])
    .executeTakeFirst();
  USER_ID = row?.id ?? 0;
  setMassPrintQueuePushForTests(async (payload) => {
    pushed.push(payload);
  });
  dryRunPrev = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
});

afterAll(async () => {
  await db.deleteFrom('os_trackings').where('tracking', '=', TEMP_TRACKING).execute();
  setMassPrintQueuePushForTests(null);
  setStampsTransportForTests(null);
  setFedexTransportForTests(null);
  setFrayunTransportForTests(null);
  vi.unstubAllGlobals();
  if (dryRunPrev === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = dryRunPrev;
});

function buildApp(): FastifyInstance {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerStampsRoutes(app);
  registerFedexRoutes(app);
  registerUpsRoutes(app);
  registerFrayunRoutes(app);
  // force a logged-in user (T10 pattern); the parity user holds the role
  app.addHook('preHandler', async (req) => {
    (req.session as Record<string, unknown>)['user_id'] = USER_ID;
  });
  return app;
}

describe('T40 stamps routes (fastify inject)', () => {
  it('guards: anonymous -> 302 /login', async () => {
    const app = Fastify();
    void app.register(formbody);
    void app.register(registerHttpHelpers);
    registerStampsRoutes(app);
    // the guard stores the intended url in the session; no session plugin in tests
    app.addHook('preHandler', async (req) => {
      if (!(req.session as Record<string, unknown>)) (req as { session?: unknown }).session = {};
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/stampsAccount' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('http://localhost:80/login');
    await app.close();
  });

  it('buyMultiLabel: 500 like the old app (method does not exist on the controller)', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/buyMultiLabel' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('buyMultiLabel does not exist');
    await app.close();
  });

  it('getMultiCleanse: 200 empty body + BullMQ MassPrintLabel job', async () => {
    pushed = [];
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/getMultiCleanse',
      headers: { 'content-type': 'application/json' },
      payload: { orders: ['O1', 'O2'], lb: '2', oz: '4', length: '10', width: '5', height: '3', packageType: 'Package', declareValue: '0', insurance: '0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(pushed).toHaveLength(1);
    const payload = JSON.parse(pushed[0]) as Record<string, unknown>;
    expect(payload.name).toBe('MassPrintLabel');
    expect(payload.data).toEqual({
      orders: ['O1', 'O2'], lb: '2', oz: '4', length: '10', width: '5', height: '3',
      packageType: 'Package', declareValue: '0', insurance: '0',
    });
    await app.close();
  });

  it('checkCleanseAddress: stubbed CleanseAddress passes through; long State is abbreviated', async () => {
    setStampsTransportForTests(async (_op, params) => {
      expect((params.Address as Record<string, unknown>).State).toBe('GA');
      return { AddressMatch: 1, CityStateZipOK: 1, Address: { State: 'GA', ZIPCode: '30041' } };
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/checkCleanseAddress',
      headers: { 'content-type': 'application/json' },
      payload: { address: { State: 'GEORGIA', ZIPCode: '30041' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: 'true', response: { AddressMatch: 1, CityStateZipOK: 1, Address: { State: 'GA', ZIPCode: '30041' } } });
    await app.close();
  });

  it('getCleanse: rate list + appended domestic UPS rate with AddOnV20 wrap', async () => {
    setStampsTransportForTests(async (_op, params) => {
      if ((params as Record<string, unknown>).Carrier === 'UPS') {
        return { Rates: { Rate: [{ Amount: '7.00', ServiceType: 'UPS-NDA', AddOns: { AddOnV20: { Amount: '1.00', AddOnType: 'CAR-A-INS' } } }] } };
      }
      return {
        AddressMatch: 1,
        CityStateZipOK: 1,
        Address: { State: 'GA', ZIPCode: '30041' },
        Authenticator: 'auth',
        Rates: { Rate: [{ Amount: '5.50', ServiceType: 'US-PM' }] },
      };
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/getCleanse',
      headers: { 'content-type': 'application/json' },
      payload: { address: { State: 'GA', ZIPCode: '30041' }, lb: '1', oz: '2', length: '10', width: '5', height: '3' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.Address).toEqual({ State: 'GA', ZIPCode: '30041' });
    const rates = body.Rates as Record<string, unknown>[];
    expect(rates).toHaveLength(2);
    expect(rates[0]).toMatchObject({ Amount: '5.50', ServiceType: 'US-PM' });
    expect(decodeURIComponent(String(rates[0].Code).replace(/\+/g, '%20'))).toBe(JSON.stringify({ Amount: '5.50', ServiceType: 'US-PM' }));
    expect(rates[1]).toMatchObject({ Amount: '7.00', ServiceType: 'UPS-NDA' });
    expect(rates[1].AddOns).toEqual({ AddOnV20: [{ Amount: '1.00', AddOnType: 'CAR-A-INS' }] });
    setStampsTransportForTests(null);
    await app.close();
  });

  it('cancelLabel: lib no-op -> JSON null (the dead DB branch is never taken)', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/cancelLabel',
      headers: { 'content-type': 'application/json' },
      payload: { stampsTxId: 'TX1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('null');
    await app.close();
  });

  it('stampsAccount / getStampsUrl / printScanForm: pass the lib result through', async () => {
    setStampsTransportForTests(async (op) => {
      if (op === 'GetAccountInfo') return { AccountInfo: { PostageBalance: { ControlTotal: '123' } } };
      if (op === 'GetURL') return { Url: 'http://example/stamps', ScanFormId: 7 };
      if (op === 'CreateScanForm') return { ScanFormId: 9 };
      throw new Error(`unexpected op ${op}`);
    });
    const app = buildApp();
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/stampsAccount' })).json()).toEqual({
      success: 'true',
      response: { AccountInfo: { PostageBalance: { ControlTotal: '123' } } },
    });
    expect((await app.inject({ method: 'GET', url: '/getStampsUrl?url=OnlineReportingSCAN' })).json()).toEqual({
      success: 'true',
      response: { Url: 'http://example/stamps', ScanFormId: 7 },
    });
    // printScanForm is a write: with DRY_RUN=1 the lib faults and the route reports success:'false'
    const scan = (await app.inject({
      method: 'POST',
      url: '/printScanForm',
      headers: { 'content-type': 'application/json' },
      payload: { stampsTxIds: ['TX1'] },
    })).json() as Record<string, unknown>;
    expect(scan.success).toBe('false');
    setStampsTransportForTests(null);
    await app.close();
  });

  it('stampsReload: DRY_RUN=1 -> purchase not sent, response is "1"', async () => {
    setStampsTransportForTests(async (op) => {
      if (op === 'GetAccountInfo') return { AccountInfo: { PostageBalance: { ControlTotal: '42' } } };
      throw new Error(`unexpected op ${op}`);
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/stampsReload' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('"1"');
    setStampsTransportForTests(null);
    await app.close();
  });
});

describe('T40 fedex routes (fastify inject)', () => {
  const rateReply = {
    RateReplyDetails: {
      ServiceType: 'FEDEX_EXPRESS_SAVER',
      DeliveryTimestamp: '2026-02-05T12:00:00',
      RatedShipmentDetails: {
        ShipmentRateDetail: { TotalNetCharge: { Amount: '31.205300' } },
      },
    },
  };

  it('fedex.getOneRate / fedex.getrate: stubbed rate reply shape', async () => {
    setFedexTransportForTests(async (service, operation) => {
      if (service === 'rate' && operation === 'getRates') return rateReply;
      throw new Error(`unexpected ${service}/${operation}`);
    });
    const app = buildApp();
    await app.ready();
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });
    const one = (await post('/fedex.getOneRate', { address: { State: 'GA', ZIPCode: '30041', Address1: 'x' }, lb: '', oz: '' })).json() as Record<string, unknown>[];
    expect(one).toEqual([
      {
        serviceType: 'FEDEX_EXPRESS_SAVER',
        amount: '31.21',
        deliveryDate: '2026-02-05T12:00:00',
      },
    ]);
    const multi = (await post('/fedex.getrate', { address: { State: 'GA', ZIPCode: '30041', Address1: 'x' }, lb: '1', oz: '8' })).json();
    expect(multi).toEqual(one);
    setFedexTransportForTests(null);
    await app.close();
  });

  it('fedex.validate: stubbed validation result', async () => {
    setFedexTransportForTests(async (service, operation) => {
      if (service === 'addressvalidation' && operation === 'addressValidation') {
        return { AddressResults: { Classification: { Type: 'R' }, EffectiveAddress: { City: 'CUMMING' } } };
      }
      throw new Error('unexpected');
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/fedex.validate',
      headers: { 'content-type': 'application/json' },
      payload: { address: { Address1: '1550 Oak Industrial Lane', Address2: 'Ste F', City: 'Cumming', State: 'GA', ZIPCode: '30041' } },
    });
    expect(res.json()).toEqual({ Classification: { Type: 'R' }, EffectiveAddress: { City: 'CUMMING' } });
    setFedexTransportForTests(null);
    await app.close();
  });

  it('fedex.void: OK flips canceled/voided on the tracking row; empty num -> empty 200', async () => {
    const now = nowDb();
    await db
      .insertInto('os_trackings')
      .values({
        orderId: 'T40VOID',
        store: 'W',
        tracking: TEMP_TRACKING,
        Url: '',
        localUrl: 'T40VOID.png',
        Amount: 0,
        created_at: now as unknown as Date, // SAFETY: dateStrings pool (T00)
        updated_at: now as unknown as Date, // SAFETY: same
      } as never)
      .execute();
    setFedexTransportForTests(async (service, operation) => {
      if (service === 'ship' && operation === 'deleteShipment') return { DeletionResult: {} };
      throw new Error('unexpected');
    });
    const app = buildApp();
    await app.ready();
    // transport is stubbed, so the DRY_RUN gate can be lifted for the void call only
    delete process.env.DRY_RUN;
    let res = await app.inject({
      method: 'POST',
      url: '/fedex.void',
      headers: { 'content-type': 'application/json' },
      payload: { trackingNum: TEMP_TRACKING },
    });
    expect(res.body).toBe('"OK"');
    const row = await db.selectFrom('os_trackings').select(['canceled', 'voided']).where('tracking', '=', TEMP_TRACKING).executeTakeFirst();
    expect(row?.canceled).toBe('true');
    expect(row?.voided).toBe(1);
    res = await app.inject({
      method: 'POST',
      url: '/fedex.void',
      headers: { 'content-type': 'application/json' },
      payload: { trackingNum: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    process.env.DRY_RUN = '1';
    setFedexTransportForTests(null);
    await app.close();
  });

  it('fedex.getLabel: DRY_RUN=1 -> no shipment, body "error", no rows written', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/fedex.getLabel',
      headers: { 'content-type': 'application/json' },
      payload: {
        orderId: 'T40LABEL',
        address: { FullName: 'x', Address1: 'a', Address2: 'b', City: 'c', State: 'GA', ZIPCode: '30041', Country: 'US', PhoneNumber: '1' },
        lb: '1', oz: '0',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('"error"');
    const row = await db.selectFrom('os_trackings').select(['Id']).where('orderId', '=', 'T40LABEL').executeTakeFirst();
    expect(row).toBeUndefined();
    await app.close();
  });
});

describe('T40 ups routes (fastify inject)', () => {
    function stubUps(body: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, _opts: unknown) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } })),
    );
  }

  it('ups.getrate: canned Rate XML -> service/amount/deliveryDate', async () => {
    stubUps(
      '<RatingServiceSelectionResponse xmlns="..."><Response><ResponseStatusCode>1</ResponseStatusCode></Response>' +
          '<RatedShipment><Service><Code>03</Code></Service><TotalCharges><CurrencyCode>USD</CurrencyCode><MonetaryValue>12.34</MonetaryValue></TotalCharges>' +
          '<TimeInTransit><ServiceSummary><Service><Code>03</Code><Description>Ground</Description></Service>' +
          '<EstimatedArrival><Arrival><Date>2026-02-05</Date><Time>NOON</Time></Arrival></EstimatedArrival></ServiceSummary></TimeInTransit></RatedShipment></RatingServiceSelectionResponse>');
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/ups.getrate',
      headers: { 'content-type': 'application/json' },
      payload: { address: { ZIPCode: '30041' }, lb: '1', oz: '0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ serviceType: 'Ground', amount: 12.34, deliveryDate: '2026-02-05 - NOON' }]);
    await app.close();
  });

  it('ups.validate: canned XAV XML', async () => {
    stubUps(
      '<AddressValidationResponse xmlns="..."><Response><ResponseStatusCode>1</ResponseStatusCode></Response>' +
          '<ValidAddressIndicator>Y</ValidAddressIndicator>' +
          '<AddressKeyFormat><ConsigneeName>Test</ConsigneeName><BuildingName>B</BuildingName></AddressKeyFormat></AddressValidationResponse>');
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/ups.validate',
      headers: { 'content-type': 'application/json' },
      payload: { address: { Address1: 'a', Address2: 'b', City: 'Cumming', State: 'GA', ZIPCode: '30041' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.isValid).toBe(true);
    expect(body.validAddress).toMatchObject({ consigneeName: 'Test', buildingName: 'B' });
    await app.close();
  });

  it('ups.void: Success flips canceled/voided and returns plain-text OK', async () => {
    const now = nowDb();
    await db
      .insertInto('os_trackings')
      .values({
        orderId: 'T40VOID',
        store: 'W',
        tracking: TEMP_TRACKING,
        Url: '',
        localUrl: 'T40VOID.png',
        Amount: 0,
        created_at: now as unknown as Date, // SAFETY: dateStrings pool (T00)
        updated_at: now as unknown as Date, // SAFETY: same
      } as never)
      .execute();
    stubUps(
      '<VoidShipmentResponse xmlns="..."><Response><ResponseStatusCode>1</ResponseStatusCode></Response>' +
          '<Status><StatusType><Code>S</Code><Description>Success</Description></StatusType></Status></VoidShipmentResponse>');
    const app = buildApp();
    await app.ready();
    // fetch is stubbed, so the DRY_RUN gate can be lifted for the void call only
    delete process.env.DRY_RUN;
    const res = await app.inject({
      method: 'POST',
      url: '/ups.void',
      headers: { 'content-type': 'application/json' },
      payload: { trackingNum: TEMP_TRACKING },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe('OK');
    const row = await db.selectFrom('os_trackings').select(['canceled', 'voided']).where('tracking', '=', TEMP_TRACKING).executeTakeFirst();
    expect(row?.canceled).toBe('true');
    expect(row?.voided).toBe(1);
    process.env.DRY_RUN = '1';
    await app.close();
  });

  it('ups.getLabel: DRY_RUN=1 -> body "error", no rows written', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/ups.getLabel',
      headers: { 'content-type': 'application/json' },
      payload: {
        orderId: 'T40ULABEL',
        address: { FullName: 'x', Address1: 'a', Address2: 'b', City: 'c', State: 'GA', ZIPCode: '30041', Country: 'US', PhoneNumber: '1' },
        'ups-package': '03',
        lb: '1', oz: '0',
      },
    });
    expect(res.body).toBe('"error"');
    const row = await db.selectFrom('os_trackings').select(['Id']).where('orderId', '=', 'T40ULABEL').executeTakeFirst();
    expect(row).toBeUndefined();
    await app.close();
  });
});

describe('T40 frayun routes (fastify inject)', () => {
  it('frayunBalance: balance JSON rendered into frayunbalance view', async () => {
    setFrayunTransportForTests(async (op) => {
      if (op === 'GetBalance') return { GetBalanceResult: '[{"Balance":"123.45","DpdNo":"D1"}]' };
      throw new Error(`unexpected ${op}`);
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/frayunBalance' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('123.45');
    expect(res.body).not.toContain('DpdNo');
    setFrayunTransportForTests(null);
    await app.close();
  });

  it('frayunDownloadLabel: GetPdfPre result string passed through as JSON', async () => {
    setFrayunTransportForTests(async (op) => {
      if (op === 'GetPdfPre') return { GetPdfPreResult: '{"DpdNo":"D1","Pdf":"abc"}' };
      throw new Error(`unexpected ${op}`);
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/frayunDownloadLabel',
      headers: { 'content-type': 'application/json' },
      payload: { dpdNo: 'D1' },
    });
    expect(res.body).toBe(JSON.stringify('{"DpdNo":"D1","Pdf":"abc"}'));
    setFrayunTransportForTests(null);
    await app.close();
  });

  it('frayunBuyLabel: zone/rate charts read, DRY_RUN=1 -> SOAP fault 500 like the old app', async () => {
    setFrayunTransportForTests(async (op) => {
      if (op === 'CreatePreToJson') throw new Error('DRY_RUN: Frayun CreatePreToJson not sent');
      throw new Error(`unexpected ${op}`);
    });
    const app = buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/frayunBuyLabel',
      headers: { 'content-type': 'application/json' },
      payload: {
        address: { State: 'GA', ZIPCode: '30041', Name: 'x', Phone: '1' },
        orderId: 'T40F',
        lb: '1', oz: '0',
        length: '10', width: '5', height: '3',
        products: [{ USD: '0', SalePrice: '0' }],
      },
    });
    expect(res.statusCode).toBe(500);
    setFrayunTransportForTests(null);
    await app.close();
  });
});
