// StampsController (routes/web.php:210-219 — all Route::any, role:admin,user,remote).
// WRITE routes (buyLabel / stampsReload / printScanForm) go through the Stamps lib,
// whose request() gates the write SOAP ops when DRY_RUN=1.
//
// buyMultiLabel (web.php:211) targets StampsController@buyMultiLabel, which does not
// exist in the old app either: Laravel 500s with a BadMethodCallException, reproduced
// below (see plan/NOTES.md).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis as IORedis } from 'ioredis';
import { config } from '../../config.js';
import { input, allInput } from '../../http.js';
import { route } from '../../router.js';
import { Stamps, type StampsAddress } from '../../lib/stamps.js';
import { db } from '../../db.js';
import { json_encode } from '../../view.js';

// PHP response()->json(): the body is a JSON literal even for plain strings.
function json(reply: FastifyReply, v: unknown) {
  reply.type('application/json; charset=utf-8');
  // Fastify sends string payloads raw; Laravel's json() encodes them
  if (typeof v === 'string' || v === null) return reply['send'](JSON.stringify(v));
  return reply['send'](v);
}

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

const FROM_ADDRESS: StampsAddress = {
  Company: 'Angel Isabella, LLC',
  Address1: '1550 Oak Industrial Lane',
  Address2: 'Ste F',
  City: 'Cumming',
  State: 'GA',
  ZIPCode: '30041',
  PostalCode: '30041',
  Country: 'US',
  PhoneNumber: '678-999-6232',
};

// PHP urlencode(): like encodeURIComponent but space -> '+' and !'()* also escaped.
function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// PHP (float) cast: ''/null -> 0, non-numeric -> 0.
function phpFloat(v: unknown): number {
  const n = Number(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

// PHP: strlen($address['State']) > 2 -> Stamps::getStateAbbr; null/missing -> 0.
function fixState(address: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!address) return address;
  if (String(address['State'] ?? '').length > 2) address['State'] = Stamps.getStateAbbr(String(address['State']));
  return address;
}

// StampsController::addressToArray
type Dyn = Record<string, unknown>;
function addressToArray(address: unknown): Dyn {
  if (Array.isArray(address)) return address as unknown as Dyn; // SAFETY: a PHP list has only scalar entries, never accessed as Dyn
  const arr: Dyn = {};
  if (address !== null && typeof address === 'object') {
    for (const [k, v] of Object.entries(address)) {
      if (v === null || v === undefined || typeof v !== 'object') arr[k] = v;
    }
  }
  return arr;
}

// StampsController::domesticUpsServices
function domesticUpsServices(): string[] {
  return ['UPS-NDAE', 'UPS-NDA', 'UPS-NDAS', 'UPS-2DAA', 'UPS-2DA', 'UPS-3DS', 'UPS-GD', 'UPS-GDS'];
}

// StampsController::appendDomesticUpsRates (mutates $rates)
async function appendDomesticUpsRates(
  rates: Dyn[], stamps: Stamps, cleansedAddress: unknown, fromAddress: StampsAddress, lb: unknown, oz: unknown,
  length: unknown, width: unknown, height: unknown, insurance: unknown, declareValue: unknown,
): Promise<void> {
  const toAddress = addressToArray(cleansedAddress);
  const country = toAddress['Country'] !== undefined ? toAddress['Country'] : 'US';
  if (country !== '' && country !== 'US') return;
  if (toAddress['ZIPCode'] === undefined && toAddress['PostalCode'] !== undefined) toAddress['ZIPCode'] = toAddress['PostalCode'];

  const upsResponse = await stamps.getUpsRates(toAddress, fromAddress, lb, oz, length, width, height, insurance, declareValue);
  if (upsResponse['success'] !== 'true') return;
  let upsRates = upsResponse['response']?.Rates?.Rate;
  if (upsRates === undefined) return;
  if (!Array.isArray(upsRates)) upsRates = [upsRates];

  const allowed = domesticUpsServices();
  for (const rate of upsRates) {
    if (rate?.ServiceType === undefined || !allowed.includes(rate.ServiceType)) continue;
    const encoded: Dyn = { ...rate };
    const addons = encoded['AddOns'] as Dyn | undefined;
    if (addons?.AddOnV20 !== undefined && (addons.AddOnV20 as Dyn)['AddOnType'] !== undefined) {
      encoded['AddOns'] = { ...addons, AddOnV20: [addons.AddOnV20] };
    }
    rates.push({
      Code: phpUrlencode(json_encode(encoded)),
      Amount: rate.Amount ?? null,
      ServiceType: rate.ServiceType,
      AddOns: encoded['AddOns'] ?? {},
    });
  }
}

// ---------------------------------------------------------------- MassPrintLabel dispatch

// PHP-serialize scalars/arrays, byte-length string form.
function phpSerializeString(s: string): string {
  return `s:${Buffer.byteLength(s, 'utf8')}:"${s}";`;
}
function phpSerialize(v: unknown): string {
  if (v === null || v === undefined) return 'N;';
  if (typeof v === 'boolean') return v ? 'b:1;' : 'b:0;';
  if (typeof v === 'number') return Number.isInteger(v) ? `i:${v};` : `d:${v};`;
  if (typeof v === 'string') return phpSerializeString(v);
  if (Array.isArray(v)) return `a:${v.length}{${v.map((x, i) => `i:${i};${phpSerialize(x)}`).join('')}}`;
  const entries = Object.entries(v as Record<string, unknown>);
  return `a:${entries.length}{${entries.map(([k, x]) => `${phpSerializeString(k)};${phpSerialize(x)}`).join('')}}`;
}

// serialize(new App\Jobs\MassPrintLabel(...)) with Laravel 5.4 property order
// (InteractsWithQueue, Queueable, then class body).
function serializeMassPrintLabel(args: {
  orders: unknown; lb: unknown; oz: unknown; length: unknown; width: unknown; height: unknown;
  packageType: unknown; declareValue: unknown; insurance: unknown;
}): string {
  const P = '\0App\Jobs\MassPrintLabel\0';
  const p = (name: string, value: unknown) => `${phpSerializeString(P + name)};${phpSerialize(value)}`;
  const fromAddress = {
    Company: 'Angel Isabella, LLC', Address1: '1550 Oak Industrial Lane', Address2: 'Ste F', City: 'Cumming',
    State: 'GA', ZIPCode: '30041', PostalCode: '30041', Country: 'US', PhoneNumber: '678-999-6232',
  };
  return `O:23:"App\\Jobs\\MassPrintLabel";{s:3:"job";N;s:6:"failed";b:0;s:10:"connection";N;s:5:"queue";N;s:18:"delayAfterFailures";N;${p(
    'fromAddress',
    fromAddress,
  )}s:5:"tries";i:1;${p('firstClass', false)}${p('orders', args.orders)}${p('lb', args.lb)}${p('oz', args.oz)}${p(
    'length',
    args.length,
  )}${p('width', args.width)}${p('height', args.height)}${p('packageType', args.packageType)}${p(
    'declareValue',
    args.declareValue,
  )}${p('insurance', args.insurance)}${p('currentJobId', null)}${p('queuejob', null)}`;
}

// Laravel 5.4 Queue::createObjectPayload -> json, RPUSH queues:default (QUEUE_DRIVER=redis).
function massPrintLabelPayload(args: Parameters<typeof serializeMassPrintLabel>[0]): string {
  return JSON.stringify({
    displayName: 'App\\Jobs\\MassPrintLabel',
    job: 'Illuminate\\Queue\\CallQueuedHandler@call',
    maxTries: 1,
    timeout: null,
    data: {
      commandName: 'App\\Jobs\\MassPrintLabel',
      command: serializeMassPrintLabel(args),
    },
  });
}

let redis: IORedis | null = null;
function defaultQueuePush(payload: string): Promise<void> {
  redis ??= new IORedis({ host: config.REDIS_HOST, port: config.REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
  // SAFETY: ioredis rpush resolves number|string on both redis replies; callers ignore the value.
  return redis.rpush('queues:default', payload) as unknown as Promise<void>;
}
let queuePush: (payload: string) => Promise<void> = defaultQueuePush;
// Test seam so unit tests never touch redis.
export function setMassPrintQueuePushForTests(fn: ((payload: string) => Promise<void>) | null): void {
  queuePush = fn ?? defaultQueuePush;
}

// ---------------------------------------------------------------- routes

export function registerStampsRoutes(app: FastifyInstance): void {
  anyRoute(app, 'getMultiCleanse', '/getMultiCleanse', async (req, reply) => {
    // dispatch(new MassPrintLabel(...)) — async via the redis queue; the controller returns nothing.
    const orders = input(req, 'orders');
    const args = {
      orders,
      lb: input(req, 'lb'),
      oz: input(req, 'oz'),
      length: input(req, 'length'),
      width: input(req, 'width'),
      height: input(req, 'height'),
      packageType: input(req, 'packageType'),
      declareValue: input(req, 'declareValue'),
      insurance: input(req, 'insurance'),
    };
    console.info('dispatch MassPrintLabel Jobs');
    await queuePush(massPrintLabelPayload(args));
    return reply.code(200).send('');
  });

  // StampsController has no buyMultiLabel() — Laravel: 500 BadMethodCallException.
  anyRoute(app, 'buyMultiLabel', '/buyMultiLabel', (_req, reply) => {
    return reply.code(500).type('text/html; charset=UTF-8').send('Method App\\Http\\Controllers\\StampsController::buyMultiLabel does not exist.');
  });

  anyRoute(app, 'getCleanse', '/getCleanse', async (req, reply) => {
    const address = fixState(input<Record<string, unknown>>(req, 'address'));
    const lb = input(req, 'lb');
    const oz = input(req, 'oz');
    const length = input(req, 'length');
    const width = input(req, 'width');
    const height = input(req, 'height');
    const packageType = input(req, 'packageType');
    const declareValue = input(req, 'declareValue');
    const insurance = input(req, 'insurance');
    const stamps = new Stamps();
    // SAFETY: PHP passes null through to the lib identically; the lib treats missing keys as null.
    const ratesResponse = await stamps.getRatesNoCleanse(
      address as unknown as StampsAddress, FROM_ADDRESS, lb, oz, length, width, height, packageType, insurance, declareValue,
    );
    const result: Dyn = {};
    const rates: Dyn[] = [];
    if (ratesResponse['success'] === 'true') {
      let list = ratesResponse['response'].Rates.Rate;
      if (!Array.isArray(list)) list = [list];
      for (const rate of list as (Dyn | undefined)[]) {
        rates.push({
          Code: phpUrlencode(json_encode(rate)),
          Amount: rate?.Amount ?? null,
          ServiceType: rate?.ServiceType ?? null,
          AddOns: rate?.AddOns ?? null,
        });
      }
      result['Address'] = ratesResponse['Address'];
      await appendDomesticUpsRates(rates, stamps, result['Address'], FROM_ADDRESS, lb, oz, length, width, height, insurance, declareValue);
      result['Rates'] = rates;
      result['success'] = true;
    } else {
      result['success'] = false;
      result['message'] = ratesResponse;
    }
    return json(reply, result);
  });

  anyRoute(app, 'buyLabel', '/buyLabel', async (req, reply) => {
    const authenicator = input(req, 'authenicator');
    const rate = input(req, 'rate');
    const memo = input(req, 'memo');
    const signature = input(req, 'signature');
    const toAddress = input<Record<string, unknown>>(req, 'address');
    const customInfo = input<unknown[]>(req, 'customInfo');

    const customs: Dyn = {};
    const lineItems: Dyn[] = [];
    if (customInfo !== null && customInfo !== undefined && typeof customInfo === 'object' && (Array.isArray(customInfo) ? customInfo.length : Object.keys(customInfo).length) > 0) {
      customs['ContentType'] = 'Commercial Sample';
      customs['Comments'] = '';
      customs['LicenseNumber'] = '';
      customs['CertificateNumber'] = '';
      customs['InvoiceNumber'] = '';
      customs['OtherDescribe'] = memo;
      for (let i = 0; i < (Array.isArray(customInfo) ? customInfo.length : Object.keys(customInfo).length); i++) {
        const item = (customInfo as Dyn[])[i];
        const lineItem: Dyn = {};
        if (String(item?.['cusDesc'] ?? '').trim() !== '') lineItem['Description'] = item['cusDesc'];
        if (String(item?.['qty'] ?? '').trim() !== '') lineItem['Quantity'] = item['qty'];
        if (String(item?.['val'] ?? '').trim() !== '') lineItem['Value'] = item['val'];
        if (String(item?.['lb'] ?? '').trim() !== '') lineItem['WeightLb'] = item['lb'];
        if (String(item?.['oz'] ?? '').trim() !== '') lineItem['WeightOz'] = item['oz'];
        if (String(item?.['cusDesc'] ?? '').trim() !== '') lineItems.push(lineItem);
      }
      customs['CustomsLines'] = lineItems;
    }
    fixState(toAddress);

    // $this->fromAddress is a per-request controller property
    const fromAddress = { ...FROM_ADDRESS };
    const all = allInput(req);
    if ('companyName' in all && all['companyName'] !== '') fromAddress['Company'] = all['companyName'];
    // SAFETY: rate/toAddress are client JSON strings/objects; the lib handles them as opaque values.
    const ratesResponse = await new Stamps().buyLabel(
      authenicator, rate as string, fromAddress, toAddress as unknown as StampsAddress, memo, customs, signature,
    );
    return json(reply, ratesResponse);
  });

  anyRoute(app, 'cancelLabel', '/cancelLabel', async (req, reply) => {
    const stampsTxId = String(input(req, 'stampsTxId') ?? '');
    const stamps = new Stamps();
    // PHP quirk: the lib method returns null; the if() branch is dead in the old app too
    const resp: unknown = stamps.cancelLabel(stampsTxId);
    if (resp) {
      const track = await db
        .selectFrom('os_trackings')
        .select(['Id', 'canceled'])
        .where('stampsTxId', '=', stampsTxId)
        .executeTakeFirst();
      if (track) await db.updateTable('os_trackings').set({ canceled: 'true' }).where('Id', '=', track.Id).execute();
    }
    return json(reply, resp ?? null);
  });

  anyRoute(app, 'stampsAccount', '/stampsAccount', async (_req, reply) => {
    const result = await new Stamps().accountInfo();
    return json(reply, result);
  });

  anyRoute(app, 'stampsReload', '/stampsReload', async (_req, reply) => {
    const stamps = new Stamps();
    const acctResult = await stamps.accountInfo();
    const amount = 300;
    const controlTotal = acctResult.response?.AccountInfo?.PostageBalance?.ControlTotal;
    const result = await stamps.purchasePostage(amount, controlTotal);
    console.info('StampsController::Reload', JSON.stringify(result));
    return json(reply, '1');
  });

  anyRoute(app, 'printScanForm', '/printScanForm', async (req, reply) => {
    const stampsTxIds = input<unknown[]>(req, 'stampsTxIds');
    const resp = await new Stamps().printScanForm(stampsTxIds, FROM_ADDRESS);
    return json(reply, resp);
  });

  anyRoute(app, 'getStampsUrl', '/getStampsUrl', async (req, reply) => {
    const url = String(input(req, 'url') ?? '');
    const resp = await new Stamps().getUrl(url);
    return json(reply, resp);
  });

  anyRoute(app, 'checkCleanseAddress', '/checkCleanseAddress', async (req, reply) => {
    const address = fixState(input<Record<string, unknown>>(req, 'address'));
    // SAFETY: PHP passes null through to the lib identically; the lib treats missing keys as null.
    const cleanseResponse = await new Stamps().getCleanse(address as unknown as StampsAddress);
    return json(reply, cleanseResponse);
  });
}

function anyRoute(app: FastifyInstance, name: string, path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown): void {
  route(app, { verb: 'any', path, name, middleware: MIDDLEWARE, handler });
}
