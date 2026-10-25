// L13: live READ-ONLY integration check. One or two read calls per integration through the same src/lib clients the app uses.
// Every outbound HTTP call is checked against scripts/liveCheckGuard.ts (default deny); SOAP clients are guarded at their
// transport seam. Nothing here creates, updates, deletes, buys, uploads or mails.
//
// Usage: pnpm live:check [--only=ebay,amazon,walmart,shopify,houzz,etsy,ups,fedex,stamps,usps,frayun,pusher,dryrun]
// Exit code 1 when any check FAILs. Secret values from the environment are redacted from all output.

import { config } from '../src/config.js';
import { assertReadOnlyOperation, guardFetch, ReadOnlyViolation } from './liveCheckGuard.js';
import { Ebay, xmlList, xmlText } from '../src/lib/ebay.js';
import { EbayApi, EbayApiError } from '../src/lib/ebayApi.js';
import { AmazonApi, AmazonApiError } from '../src/lib/amazonApi.js';
import { Walmart } from '../src/lib/walmart.js';
import { Shopify } from '../src/lib/shopify.js';
import { Houzz } from '../src/lib/houzz.js';
import { EtsyClient } from '../src/lib/etsy.js';
import { UpsClient } from '../src/lib/ups.js';
import { FedexClient, setFedexTransportForTests, soapTransport as fedexSoap } from '../src/lib/fedex.js';
import { Stamps, setStampsTransportForTests, soapTransport as stampsSoap } from '../src/lib/stamps.js';
import { Usps } from '../src/lib/usps.js';
import { Frayun, setFrayunTransportForTests, soapTransport as frayunSoap, request as frayunRequest } from '../src/lib/frayun.js';
import { request as stampsRequest } from '../src/lib/stamps.js';

void config; // loads + validates .env (dotenv) like the app does

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result {
  integration: string;
  check: string;
  status: Status;
  http: string;
  note: string;
}

// ---- redaction ----

const SECRET_KEY = /TOKEN|SECRET|PASSWORD|KEY|CERTID|DEVID|REFRESH|APPID|USERNAME|USER_ID|ACCOUNT|METER|APP_ID|ROLE_ARN/i;
const secrets = Object.entries(process.env)
  .filter(([k, v]) => SECRET_KEY.test(k) && (v ?? '').length >= 6)
  .map(([, v]) => v as string)
  .sort((a, b) => b.length - a.length);
const redact = (s: string): string => secrets.reduce((acc, v) => acc.split(v).join('***'), s).replace(/(Bearer|Basic|OAuth) [A-Za-z0-9._~+/=-]{12,}/g, '$1 ***');

// ---- guards: fetch (HTTP clients) + transport seam (SOAP clients) ----

let netLog: string[] = [];
const networkCalls = (): number => netLog.length;
globalThis.fetch = guardFetch(globalThis.fetch, (line) => netLog.push(line));

function guardSoap<A extends unknown[]>(name: 'stamps' | 'frayun', inner: (op: string, ...rest: A) => Promise<any>) {
  return async (op: string, ...rest: A) => {
    assertReadOnlyOperation(name, op);
    try {
      const res = await inner(op, ...rest);
      netLog.push(`SOAP ${name} ${op} -> ok`);
      return res;
    } catch (e) {
      netLog.push(`SOAP ${name} ${op} -> fault`);
      throw e;
    }
  };
}
setStampsTransportForTests(guardSoap('stamps', stampsSoap));
setFrayunTransportForTests(guardSoap('frayun', frayunSoap));
setFedexTransportForTests(async (service, operation, params) => {
  assertReadOnlyOperation('fedex', operation);
  const res = await fedexSoap(service, operation, params);
  netLog.push(`SOAP fedex ${operation} -> ${res?.HighestSeverity ?? 'ok'}`);
  return res;
});

// ---- harness ----

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const results: Result[] = [];
let consoleLines: string[] = [];
const out = (line: string): void => void process.stdout.write(line + '\n');

class Skip extends Error {}
class Note extends Error {} // a PASS with an explanatory note
const skip = (why: string): never => { throw new Skip(why); };
const passNote = (why: string): never => { throw new Note(why); };
const must = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

// One retry max (these are reads), after a short pause.
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReadOnlyViolation || e instanceof Skip || e instanceof Note) throw e;
    await sleep(1500);
    return fn();
  }
}

async function check(integration: string, name: string, fn: () => Promise<string>): Promise<void> {
  netLog = [];
  consoleLines = [];
  let status: Status = 'PASS';
  let note = '';
  try {
    note = await attempt(fn);
  } catch (e) {
    if (e instanceof Skip) (status = 'SKIP'), (note = e.message);
    else if (e instanceof Note) note = e.message;
    else {
      status = 'FAIL';
      note = e instanceof Error ? e.message : String(e);
      const extra = consoleLines.join(' | ');
      if (extra) note += ` [log: ${extra.slice(0, 300)}]`;
    }
  }
  const http = [...new Set(netLog.map((l) => l.replace(/^(\S+) (\S+?)\/.*-> (\S+)$/, '$3')))].join(',') || '-';
  const r: Result = { integration, check: name, status, http, note: redact(note).replace(/\s+/g, ' ').slice(0, 400) };
  results.push(r);
  out(`${r.status.padEnd(4)} ${integration}/${name}  http=${r.http}  ${r.note}`);
  await sleep(300);
}

// Client console noise (it can carry order data) is captured for failure diagnosis, never printed.
for (const level of ['info', 'log', 'error', 'warn'] as const) {
  console[level] = (...args: unknown[]) => {
    consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

// ---- shared sample data (public landmarks / the app's own warehouse; nothing is written) ----

const WAREHOUSE = { Company: 'Angel Isabella, LLC', Address1: '1550 Oak Industrial Lane', Address2: 'Ste F', City: 'Cumming', State: 'GA', ZIPCode: '30041', PostalCode: '30041', Country: 'US', PhoneNumber: '678-999-6232' };
const TO_ADDRESS = { FullName: 'Test Recipient', Address1: '350 5th Ave', City: 'New York', State: 'NY', ZIPCode: '10118', Country: 'US' };
const FEDEX_SHIPPER = { Contact: { CompanyName: 'Angel Isabella LLC', PhoneNumber: '6789996232' }, Address: { StreetLines: ['1550 Oak Industrial Lane', 'Ste F'], City: 'Cumming', StateOrProvinceCode: 'GA', PostalCode: 30041, CountryCode: 'US' } };
const daysAgoIso = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const ackOk = (r: any, what: string): void => {
  const ack = xmlText(r?.Ack);
  if (ack !== 'Success' && ack !== 'Warning') {
    const err = xmlList(r?.Errors)[0];
    throw new Error(`${what}: Ack=${ack || '(none)'} ${xmlText(err?.ErrorCode)} ${xmlText(err?.ShortMessage)}`.trim());
  }
};

// ---- integrations ----

async function ebayTrading(store: 'ebay' | 'raystore'): Promise<void> {
  const e = new Ebay(store);
  let firstItem = '';
  await check(store, 'GetMyeBaySelling(ActiveList p1)', async () => {
    if (!process.env[`${store.toUpperCase()}_TOKEN`]) skip('no token configured');
    const r = await e.getActiveListing(1);
    ackOk(r, 'GetMyeBaySelling');
    const items = xmlList(r.ActiveList?.ItemArray?.Item);
    firstItem = xmlText(items[0]?.ItemID);
    const total = xmlText(r.ActiveList?.PaginationResult?.TotalNumberOfEntries) || '0';
    if (!firstItem) return passNote(`Ack=${xmlText(r.Ack)}; token valid, no active listings (empty store)`);
    return `Ack=${xmlText(r.Ack)}; ${items.length} items on page, total ${total}`;
  });
  await check(store, 'GetItem(first active listing)', async () => {
    if (!firstItem) skip('no active listing to read');
    const r = await e.getItem(firstItem);
    ackOk(r, 'GetItem');
    must(xmlText(r.Item?.ItemID) === firstItem, 'GetItem reply has no matching Item.ItemID');
    return `Ack=${xmlText(r.Ack)}; Item.ItemID matches, Title present=${xmlText(r.Item?.Title) !== ''}`;
  });
}

async function ebayRest(): Promise<void> {
  const api = new EbayApi('ebay');
  await check('ebay', 'REST oauth refresh + GetUnshippedOrders', async () => {
    if (!process.env.EBAY_OAUTH_REFRESH_TOKEN) skip('no EBAY_OAUTH_REFRESH_TOKEN');
    const r = await api.GetUnshippedOrders();
    if (r?.errors) throw new EbayApiError(`REST errors: ${JSON.stringify(r.errors).slice(0, 200)}`);
    must(r && typeof r === 'object' && ('orders' in r || 'total' in r), 'reply has neither orders nor total');
    return `total=${r.total ?? '?'}, orders on page=${Array.isArray(r.orders) ? r.orders.length : 0}`;
  });
}

async function amazon(): Promise<void> {
  await check('amazon', 'LWA+STS+getReports(GET)', async () => {
    if (!process.env.AMZ_LWA_REFRESH_TOKEN) skip('no AMZ_* credentials');
    try {
      const r = await new AmazonApi().getReportRequestList();
      must(Array.isArray(r?.reports), 'reply has no reports[]');
      return r.reports.length === 0 ? passNote('auth + signing OK; no DONE actionable-order reports in the last 7 days') : `reports on page=${r.reports.length}`;
    } catch (e) {
      if (e instanceof AmazonApiError) throw new Error(`${e.message.slice(0, 250)}`);
      throw e;
    }
  });
}

async function walmart(): Promise<void> {
  const w = new Walmart();
  await check('walmart', 'token + GET orders limit=1', async () => {
    if (!process.env.WALMART_CLIENT_ID) skip('no WALMART_* credentials');
    const body = await w.httpPost(`https://marketplace.walmartapis.com/v3/orders?limit=1&createdStartDate=${daysAgoIso(2)}`, 'GET');
    if (/<(ns\d:)?errors?>/i.test(body) && !/totalCount/.test(body)) throw new Error(`error reply: ${body.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`);
    must(/<(ns\d:)?(elements|list|meta)/i.test(body), 'reply is not an orders list');
    const total = /<(?:ns\d:)?totalCount>(\d+)</.exec(body)?.[1] ?? '0';
    return total === '0' ? passNote('token + signing OK; no orders created in the last 2 days') : `orders totalCount=${total}`;
  });
  const dsv = new Walmart();
  dsv.dsv();
  await check('walmart', 'DSV token + GET orders limit=1', async () => {
    if (!process.env.WALMART_DSV_CHANNEL_TYPE) skip('no DSV config');
    const body = await dsv.httpPost(`https://api-gateway.walmart.com/v3/orders?shipNode=${process.env.WALMART_DSV_SHIPNODE}&limit=1&createdStartDate=${daysAgoIso(2)}`, 'GET');
    if (/<(ns\d:)?errors?>/i.test(body)) throw new Error(`error reply: ${body.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`);
    return /<(ns\d:)?(elements|list|meta)/i.test(body) ? 'orders list reply' : passNote('token OK; empty orders reply');
  });
}

async function shopify(): Promise<void> {
  const s = new Shopify();
  await check('shopify', 'GET admin/shop.json', async () => {
    if (!process.env.SHOPIFY_PASSWORD) skip('no SHOPIFY_* credentials');
    const shop = await s.call('GET', 'admin/shop.json');
    const st = s.lastResponseHeaders?.http_status_code;
    must(shop && typeof shop === 'object' && shop.id, `no shop object (status ${st})`);
    return `shop.id present, name=${String(shop.name)}, plan=${String(shop.plan_name ?? '?')}`;
  });
  await check('shopify', 'GET admin/orders.json limit=1', async () => {
    if (!process.env.SHOPIFY_PASSWORD) skip('no SHOPIFY_* credentials');
    const orders = await s.call('GET', 'admin/orders.json', { limit: '1', status: 'any' });
    must(Array.isArray(orders), `orders is not a list (status ${s.lastResponseHeaders?.http_status_code})`);
    return orders.length === 0 ? passNote('auth OK; store has no orders') : `1 order read, id present=${Boolean(orders[0].id)}`;
  });
}

async function houzz(): Promise<void> {
  await check('houzz', 'getOrders(Active)', async () => {
    if (!process.env.HOUZZ_TOKEN) skip('no HOUZZ_* credentials');
    const body = await new Houzz().getUnshippedOrders();
    must(typeof body === 'string' && body !== '', 'empty reply');
    let j: any;
    try { j = JSON.parse(body as string); } catch { throw new Error(`non-JSON reply: ${(body as string).slice(0, 120)}`); }
    must(j.Ack === 'Success' || j.Ack === 'Warning', `Ack=${j.Ack} ${JSON.stringify(j.Errors ?? j.Error ?? j.Message ?? '').slice(0, 160)}`);
    const orders = j.Orders ?? j.Order ?? [];
    return (Array.isArray(orders) ? orders.length : 1) === 0 ? passNote(`Ack=${j.Ack}; no active orders`) : `Ack=${j.Ack}; active orders=${Array.isArray(orders) ? orders.length : 1}`;
  });
}

async function etsy(): Promise<void> {
  for (const store of [1, 2, 3]) {
    await check('etsy', `store${store} GET shops/__SELF__/sections`, async () => {
      if (!process.env[`ETSY_TOKEN${store}`]) skip('no token configured');
      const r = await new EtsyClient(store).getCategories();
      must(r && typeof r === 'object' && ('results' in r || 'count' in r), `unexpected reply ${JSON.stringify(r)?.slice(0, 120)}`);
      return r.count === 0 ? passNote('auth OK; shop has no sections') : `count=${r.count ?? r.results.length}`;
    });
  }
}

async function ups(): Promise<void> {
  const u = new UpsClient();
  const mode = (process.env.UPS_SANDBOX ?? '').toLowerCase() === 'true' ? 'sandbox' : 'production';
  await check('ups', `XAV address validation (${mode})`, async () => {
    if (!process.env.UPS_ACCESS_KEY) skip('no UPS_* credentials');
    const r = await u.validateAddress(['350 5th Ave'], 'New York', 'NY', '10118');
    return r.isValid ? 'XAV reply, address valid' : passNote('XAV answered but did not validate the sample address');
  });
  await sleep(5000); // UPS throttles bursts (10429)
  await check('ups', `Rate shop (${mode})`, async () => {
    if (!process.env.UPS_ACCESS_KEY) skip('no UPS_* credentials');
    const r = await u.getRate('30041', '10118', 2, 6, 6, 6);
    must(Array.isArray(r) && r.length > 0, 'no rated services returned');
    return `${r.length} rated services, first=${r[0].serviceType}`;
  });
}

async function fedex(): Promise<void> {
  const f = new FedexClient();
  await check('fedex', 'addressValidation', async () => {
    if (!process.env.FEDEX_KEY) skip('no FEDEX_* credentials');
    const sev = () => netLog.find((l) => l.startsWith('SOAP fedex'))?.split('-> ')[1] ?? '';
    const r = await f.validateAddress(['350 5th Ave'], 'New York', 'NY', '10118');
    if (['FAILURE', 'ERROR'].includes(sev())) throw new Error(`HighestSeverity=${sev()}`);
    return Array.isArray(r) ? passNote(`SOAP ok (severity ${sev()}) but no validated address returned`) : `severity ${sev()}, Classification=${String(r.Classification)}`;
  });
  await check('fedex', 'getRates', async () => {
    if (!process.env.FEDEX_KEY) skip('no FEDEX_* credentials');
    const r = await f.getRate(FEDEX_SHIPPER, 6, 6, 6, 2, false, false, ['350 5th Ave'], 'New York', 'NY', '10118');
    must(r.length > 0, `no rates returned (${netLog.find((l) => l.startsWith('SOAP fedex')) ?? 'no SOAP call'})`);
    return `${r.length} rate(s), first=${r[0].serviceType}`;
  });
}

async function stamps(): Promise<void> {
  const s = new Stamps();
  await check('stamps', 'GetAccountInfo', async () => {
    if (!process.env.STAMPS_USERNAME) skip('no STAMPS_* credentials');
    const r = await s.accountInfo();
    must(r.success === 'true', `fault: ${String(r.message?.faultstring ?? r.message)}`);
    must(r.response?.AccountInfo, 'reply has no AccountInfo');
    return `AccountInfo present, Authenticator returned=${Boolean(r.response.Authenticator)}`;
  });
  await check('stamps', 'CleanseAddress + GetRates (no purchase)', async () => {
    if (!process.env.STAMPS_USERNAME) skip('no STAMPS_* credentials');
    const r = await s.getRatesNoCleanse(TO_ADDRESS, WAREHOUSE, 1, 0, 6, 6, 6, 'Package', 0, 0);
    must(r.success === 'true', `${r.step ?? ''} ${String(r.message?.faultstring ?? r.message)}`.trim());
    const rates = r.response?.Rates?.Rate;
    return `rates=${Array.isArray(rates) ? rates.length : rates ? 1 : 0}`;
  });
}

async function usps(): Promise<void> {
  await check('usps', 'RateV4', async () => {
    if (!process.env.USPS_USERNAME) skip('no USPS_* credentials');
    const r = await new Usps().getRate('30041', '10118', 'PRIORITY', 1, 0, 10, 8, 4);
    must(r !== false, 'reply is not XML');
    const err = r.Package?.Error ?? r.Description;
    if (r.Number !== undefined || err) throw new Error(`USPS error: ${JSON.stringify(err ?? r).slice(0, 200)}`);
    return `Zone=${xmlText(r.Package?.Zone)}, Rate=${xmlText(r.Package?.Postage?.Rate)}`;
  });
}

async function frayun(): Promise<void> {
  await check('frayun', 'GetBalance', async () => {
    if (!process.env.FRAYUN_USERNAME) skip('no FRAYUN_* credentials');
    const b = await new Frayun().getBalance();
    must(b !== '' && b !== 'undefined' && !Number.isNaN(Number(b)), `unexpected GetBalanceResult "${b.slice(0, 80)}"`);
    return 'GetBalanceResult numeric';
  });
}

async function pusher(): Promise<void> {
  await check('pusher', 'write-only', async () => skip('Pusher is write-only (trigger); no read endpoint is called'));
}

// With DRY_RUN=1 every write method must stop before the network: no HTTP/SOAP call may be logged.
async function dryRun(): Promise<void> {
  const { EtsyClient: Etsy } = await import('../src/lib/etsy.js');
  const writes: [string, () => Promise<unknown>][] = [
    ['ebay.CompleteSale', () => new Ebay('ebay').completeSales('1', '2', 'Z123')],
    ['ebay.ReviseItem', () => new Ebay('ebay').reviseItemDescription('1', 'x')],
    ['ebayRest.shipping_fulfillment', () => new EbayApi('ebay').UploadShipping('1', [], '123456789012345')],
    ['amazon.createShipment', () => new AmazonApi().createShipment('1', 1, 1, 1, 1, [], 'svc')],
    ['amazon.patchListing', () => new AmazonApi().patchListing('sku', 'type', 'n', 'd', [])],
    ['walmart.ackOrder', () => new Walmart().ackOrder('1')],
    ['shopify.POST fulfillments', () => new Shopify().call('POST', 'admin/orders/1/fulfillments.json', { fulfillment: {} })],
    ['houzz.updateOrder(Ship)', () => new Houzz().shipOrder('1')],
    ['etsy.postTracking', () => new Etsy(1).postTracking('1', 'Z123')],
    ['ups.deleteShipment', () => new UpsClient().deleteShipment('1Z999')],
    ['fedex.deleteShipment', () => new FedexClient().deleteShipment('123')],
    ['stamps.purchasePostage', () => new Stamps().purchasePostage(1, 1)],
    ['stamps.CreateIndicium', () => stampsRequest('CreateIndicium', {})],
    ['frayun.CreatePreToJson', () => frayunRequest('CreatePreToJson', {})],
  ];
  await check('dryrun', 'DRY_RUN=1 blocks every write method before the network', async () => {
    const prev = process.env.DRY_RUN;
    process.env.DRY_RUN = '1';
    const leaked: string[] = [];
    try {
      for (const [name, fn] of writes) {
        const before = networkCalls();
        await fn().catch(() => undefined);
        if (networkCalls() !== before) leaked.push(name);
      }
    } finally {
      if (prev === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = prev;
    }
    must(leaked.length === 0, `reached the network layer: ${leaked.join(', ')}`);
    return `${writes.length}/${writes.length} write methods stopped before any HTTP/SOAP call`;
  });
}

const INTEGRATIONS: Record<string, () => Promise<void>> = {
  ebay: async () => { await ebayTrading('ebay'); await ebayRest(); await ebayTrading('raystore'); },
  amazon, walmart, shopify, houzz, etsy, ups, fedex, stamps, usps, frayun, pusher, dryrun: dryRun,
};

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const unknown = (only ?? []).filter((n) => !(n in INTEGRATIONS));
if (unknown.length > 0) {
  out(`unknown integration(s): ${unknown.join(', ')}; valid: ${Object.keys(INTEGRATIONS).join(', ')}`);
  process.exit(2);
}

out(`live:check (READ-ONLY) ${new Date().toISOString()} — ${only ? only.join(',') : 'all integrations'}`);
for (const name of only ?? Object.keys(INTEGRATIONS)) await INTEGRATIONS[name]();

const count = (s: Status): number => results.filter((r) => r.status === s).length;
out(`\nPASS ${count('PASS')}  FAIL ${count('FAIL')}  SKIP ${count('SKIP')}`);
process.exit(count('FAIL') > 0 ? 1 : 0);
