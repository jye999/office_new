// L11: real label jobs. Stamps / Frayun / Amazon run on their stubbed transports, label downloads on a stubbed fetch,
// label files land in a temp STORAGE_DIR, and the ZZL11* rows are removed afterwards. No carrier is ever contacted.
import fs from 'node:fs';
import path from 'node:path';
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/l11-storage-${process.pid}`;
  process.env.STORAGE_DIR = dir;
  return dir;
});

import { db, nowDb } from '../src/db.js';
import { processOfficeJob } from '../src/jobs/handlers.js';
import type { OfficeJobData, OfficeJobName } from '../src/jobs/queue.js';
import { setAmazonTransportForTests } from '../src/lib/amazonApi.js';
import { FrayunFault, setFrayunTransportForTests } from '../src/lib/frayun.js';
import { setStampsTransportForTests, StampsFault } from '../src/lib/stamps.js';
import { setPusherClientForTests } from '../src/pusher.js';

const NOW = nowDb() as unknown as Date;
const job = (name: OfficeJobName, data: OfficeJobData) => ({ name, data }) as Job<OfficeJobData, void, OfficeJobName>;
const labelFile = (name: string) => path.join(STORAGE, 'app/public/labels/labels', name);

let firstQueueRow = 0;
let stampsCalls: string[];
let frayunCalls: string[];
let amazonPaths: string[];
let events: string[];
let stampsReplies: Record<string, (params: any) => any>;
let frayunReplies: Record<string, (params: any) => any>;
let amazonFail = false;
let fetchSpy: ReturnType<typeof vi.spyOn>;

async function cleanup() {
  const jobs = (await db.selectFrom('os_queuejob_order').select('jobId').where('orderId', 'like', 'ZZL11%').execute()).map((r) => r.jobId);
  if (jobs.length) await db.deleteFrom('os_queuejobs').where('queueId', 'in', jobs).where('id', '>', firstQueueRow).execute();
  await db.deleteFrom('os_queuejob_order').where('orderId', 'like', 'ZZL11%').execute();
  await db.deleteFrom('os_trackings').where('orderId', 'like', 'ZZL11%').execute();
  await db.deleteFrom('os_grant_orderdetail').where('orderId', 'like', 'ZZL11%').execute();
  await db.deleteFrom('os_grant_order').where('orderId', 'like', 'ZZL11%').execute();
  await db.deleteFrom('os_product_map').where('sku', 'like', 'ZZL11%').execute();
  const products = await db.selectFrom('os_products').select('id').where('sku', 'like', 'ZZL11%').execute();
  for (const p of products) await db.deleteFrom('os_product_locations').where('product_id', '=', p.id).execute();
  await db.deleteFrom('os_products').where('sku', 'like', 'ZZL11%').execute();
}

async function seedOrder(orderId: string, sku = 'ZZL11SKU') {
  await db.insertInto('os_grant_order').values({ store: 'A', orderId, recipientName: 'Test Buyer', address1: '1 Main St', city: 'Atlanta', state: 'Georgia', zip: '30301-1234', country: 'US', phone: '555', created_at: NOW, updated_at: NOW } as never).execute();
  await db.insertInto('os_grant_orderdetail').values({ store: 'A', orderId, itemId: `${orderId}-I`, name: 'Widget', qty: 2, sku, created_at: NOW, updated_at: NOW } as never).execute();
}

const orderStatus = async (orderId: string) => (await db.selectFrom('os_grant_order').select('status').where('orderId', '=', orderId).executeTakeFirstOrThrow()).status;
const trackings = (orderId: string) => db.selectFrom('os_trackings').selectAll().where('orderId', '=', orderId).execute();
const lastQueueJob = async () => db.selectFrom('os_queuejobs').selectAll().where('id', '>', firstQueueRow).orderBy('id', 'desc').executeTakeFirstOrThrow();

beforeAll(async () => {
  firstQueueRow = Number((await db.selectFrom('os_queuejobs').select(db.fn.max('id').as('m')).executeTakeFirst())?.m ?? 0);
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  fs.rmSync(STORAGE, { recursive: true, force: true });
});

beforeEach(async () => {
  await cleanup();
  delete process.env.DRY_RUN;
  Object.assign(process.env, { AMZ_LWA_CLIENT_ID: 'c', AMZ_LWA_CLIENT_SECRET: 's', AMZ_LWA_REFRESH_TOKEN: 'r', AMZ_ACCESS_KEY_ID: 'k', AMZ_ACCESS_SECRET: 'x', AMZ_ROLE_ARN: 'arn:aws:iam::1:role/R' });
  stampsCalls = [];
  frayunCalls = [];
  amazonPaths = [];
  events = [];
  amazonFail = false;
  stampsReplies = {
    CleanseAddress: () => ({ AddressMatch: true, CityStateZipOK: true, Address: { City: 'ATLANTA' } }),
    GetRates: () => ({ Authenticator: 'a', Rates: { Rate: [{ ServiceType: 'US-FC', Amount: 3 }, { ServiceType: 'US-GA', Amount: 4 }] } }),
    CreateIndicium: () => ({ TrackingNumber: 'TRK1', URL: 'https://label.test/a.png', Rate: { Amount: 4 }, StampsTxID: 'TX1' }),
  };
  frayunReplies = {
    CreatePreToJson: () => ({ CreatePreToJsonResult: JSON.stringify([{ ResultCode: '00000', DpdNo: 'DPD1', Total: 2.5 }]) }),
    GetPdfPre: () => ({ GetPdfPreResult: JSON.stringify([{ TurnNo: 'TURN1', PdfUrl: 'https://label.test/f.pdf' }]) }),
  };
  setStampsTransportForTests(async (operation, params) => {
    stampsCalls.push(operation);
    return stampsReplies[operation](params);
  });
  setFrayunTransportForTests(async (operation, params) => {
    frayunCalls.push(operation);
    return frayunReplies[operation](params);
  });
  setAmazonTransportForTests(async (req) => {
    const u = new URL(req.url);
    if (u.host === 'api.amazon.com') return { status: 200, body: JSON.stringify({ access_token: 'T', expires_in: 3600 }) };
    if (u.host.startsWith('sts.')) return { status: 200, body: JSON.stringify({ AssumeRoleResponse: { AssumeRoleResult: { Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: Math.floor(Date.now() / 1000) + 3600 } } } }) };
    amazonPaths.push(u.pathname);
    if (amazonFail) return { status: 400, body: '{"errors":[{"message":"nope"}]}' };
    if (u.pathname.endsWith('eligibleShippingServices')) {
      return { status: 200, body: JSON.stringify({ payload: { ShippingServiceList: [{ ShippingServiceName: 'Pricey', ShippingServiceId: 'SVC_HI', Rate: { Amount: 9 } }, { ShippingServiceName: 'Cheap', ShippingServiceId: 'SVC_LO', Rate: { Amount: 5.1 } }] } }) };
    }
    return { status: 200, body: JSON.stringify({ payload: { ShipmentId: 'SH1', TrackingId: 'TR1', Label: { FileContents: { Contents: Buffer.from('AMZLABEL').toString('base64') } }, ShippingService: { Rate: { Amount: 5.1 } } } }) };
  });
  setPusherClientForTests({ trigger: async (channel: string, event: string, data: { result: string }) => void events.push(`${channel}|${event}|${data.result}`) } as never);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (!String(input).startsWith('https://label.test/')) throw new Error(`unexpected fetch ${String(input)}`);
    return new Response(Buffer.from('CARRIERLABEL'));
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setStampsTransportForTests(null);
  setFrayunTransportForTests(null);
  setAmazonTransportForTests(null);
  setPusherClientForTests(null);
  delete process.env.DRY_RUN;
  vi.restoreAllMocks();
});

const massData = (orders: string[]) => ({ orders, lb: 0, oz: 5, length: 6, width: 6, height: 4, packageType: 'Package', declareValue: 0, insurance: 0 });

describe('MassPrintLabel', () => {
  it('buys the US-GA rate, stores the label, closes the order, deducts stock and marks the job success', async () => {
    await seedOrder('ZZL11A');
    const product = await db.insertInto('os_products').values({ name: 'ZZL11 product', sku: 'ZZL11SKU', created_at: NOW, updated_at: NOW } as never).executeTakeFirstOrThrow();
    await db.insertInto('os_product_map').values({ sku: 'ZZL11SKU', store: 'A', externalId: 'ZZL11SKU', qty: 1 } as never).execute();
    await db.insertInto('os_product_locations').values({ product_id: Number(product.insertId), location: 'L1', qty: 10, created_at: NOW, updated_at: NOW } as never).execute();
    let indicium: any;
    let cleansed: any;
    stampsReplies.CleanseAddress = (params) => ((cleansed = params), { AddressMatch: true, CityStateZipOK: true, Address: { City: 'ATLANTA' } });
    stampsReplies.CreateIndicium = (params) => ((indicium = params), { TrackingNumber: 'TRK1', URL: 'https://label.test/a.png', Rate: { Amount: 4 }, StampsTxID: 'TX1' });

    await processOfficeJob(job('MassPrintLabel', massData(['ZZL11A'])));

    expect(stampsCalls).toEqual(['CleanseAddress', 'GetRates', 'CreateIndicium']);
    expect(indicium.Rate.ServiceType).toBe('US-GA');
    expect(indicium.memo).toBe('A ZZL11A ZZL11SKUX1');
    expect(cleansed.Address).toMatchObject({ State: 'GA', City: 'ATLANTA', ZIPCode: '30301' });
    expect(indicium.To).toEqual({ City: 'ATLANTA' }); // the cleansed address Stamps returned, as in the PHP
    expect(await orderStatus('ZZL11A')).toBe('submit');
    const [t] = await trackings('ZZL11A');
    expect([t.tracking, t.Url, t.Amount, t.stampsTxId, t.localUrl, t.store]).toEqual(['TRK1', 'https://label.test/a.png', 4, 'TX1', 'ZZL11A.png', 'A']);
    expect(fs.readFileSync(labelFile('ZZL11A.png'), 'utf8')).toBe('CARRIERLABEL');
    expect((await db.selectFrom('os_product_locations').select('qty').where('product_id', '=', Number(product.insertId)).executeTakeFirstOrThrow()).qty).toBe(8);
    const q = await lastQueueJob();
    expect([q.type, q.status]).toEqual(['label', 'success']);
    expect(await db.selectFrom('os_queuejob_order').select('orderId').where('jobId', '=', q.queueId).execute()).toEqual([{ orderId: 'ZZL11A' }]);
    expect(events[0]).toMatch(/^label\|App\\Events\\LabelDoneEvent\|mass print \d+ started$/);
    expect(events.at(-1)).toContain('click to print');
  });

  it('a Stamps purchase failure frees the order, keeps the job at `start` and reports the message', async () => {
    await seedOrder('ZZL11B');
    stampsReplies.CreateIndicium = () => {
      throw new StampsFault('Insufficient funds');
    };
    await processOfficeJob(job('MassPrintLabel', massData(['ZZL11B'])));
    expect(await orderStatus('ZZL11B')).toBeNull();
    expect(await trackings('ZZL11B')).toEqual([]);
    expect((await lastQueueJob()).status).toBe('start');
    expect(events.at(-1)).toMatch(/^label\|.*\|failed: \d+<br>A ZZL11B <br>Insufficient funds<br>$/);
  });

  it('a rate failure marks the order free with the legacy `error <br>` message', async () => {
    await seedOrder('ZZL11C');
    stampsReplies.GetRates = () => {
      throw new StampsFault('bad rate');
    };
    await processOfficeJob(job('MassPrintLabel', massData(['ZZL11C'])));
    expect(await orderStatus('ZZL11C')).toBeNull();
    expect(stampsCalls).not.toContain('CreateIndicium');
    expect(events.at(-1)).toMatch(/failed: \d+<br>error <br>$/);
  });

  it('a label download failure fails the job (tries=1): row `failed`, error rethrown, tracking kept without localUrl', async () => {
    await seedOrder('ZZL11D');
    fetchSpy.mockImplementation(async () => new Response('gone', { status: 404 }));
    await expect(processOfficeJob(job('MassPrintLabel', massData(['ZZL11D'])))).rejects.toThrow(/HTTP 404/);
    const q = await lastQueueJob();
    expect(q.status).toBe('failed');
    expect(await orderStatus('ZZL11D')).toBe('submit');
    expect((await trackings('ZZL11D'))[0].localUrl).toBeNull();
    expect(events.at(-1)).toBe(`label|App\\Events\\LabelDoneEvent|failed:${q.id}`);
  });

  it('rejects a payload whose orders is not a list', async () => {
    await expect(processOfficeJob(job('MassPrintLabel', { ...massData([]), orders: null }))).rejects.toThrow(TypeError);
    expect((await lastQueueJob()).status).toBe('failed');
  });
});

describe('AmzMassPrintLabel', () => {
  const amzData = { orders: ['ZZL11E'], lb: 0, oz: 5, length: 6, width: 6, height: 4 };

  it('ships with the cheapest Amazon service, stores the PNG and records a store-A tracking', async () => {
    await seedOrder('ZZL11E');
    await processOfficeJob(job('AmzMassPrintLabel', amzData));
    expect(amazonPaths).toEqual(['/mfn/v0/eligibleShippingServices', '/mfn/v0/eligibleShippingServices', '/mfn/v0/shipments']);
    expect(await orderStatus('ZZL11E')).toBe('Done');
    const [t] = await trackings('ZZL11E');
    expect([t.tracking, t.Url, t.localUrl, t.store, t.Amount]).toEqual(['TR1', 'SH1', 'ZZL11E.png', 'A', 5.1]);
    expect(fs.readFileSync(labelFile('ZZL11E.png'), 'utf8')).toBe('AMZLABEL');
    expect((await lastQueueJob()).status).toBe('success');
  }, 15_000);

  it('an Amazon error is never caught (PHP catches a missing class): job failed, order stays printing', async () => {
    await seedOrder('ZZL11E');
    amazonFail = true;
    await expect(processOfficeJob(job('AmzMassPrintLabel', amzData))).rejects.toThrow();
    expect(await orderStatus('ZZL11E')).toBe('printing');
    expect((await lastQueueJob()).status).toBe('failed');
  });
});

describe('FrayunMassPrintLabel', () => {
  const frayunData = { orders: ['ZZL11F'], lb: 0, oz: 5, length: 6, width: 6, height: 4, packageType: 'FIRST CLASS' };

  it('buys, downloads the PDF label and records the tracking', async () => {
    await seedOrder('ZZL11F');
    let bought: any;
    frayunReplies.CreatePreToJson = (params) => ((bought = params), { CreatePreToJsonResult: JSON.stringify([{ ResultCode: '00000', DpdNo: 'DPD1', Total: 2.5 }]) });
    await processOfficeJob(job('FrayunMassPrintLabel', frayunData));
    expect(frayunCalls).toEqual(['CreatePreToJson', 'GetPdfPre']);
    expect(bought.JsonData).toContain('"ActualWeight":0.141'); // floor(5 oz * 28.35) / 1000 kg
    expect(await orderStatus('ZZL11F')).toBe('submit');
    const [t] = await trackings('ZZL11F');
    expect([t.tracking, t.Url, t.Amount, t.stampsTxId, t.localUrl]).toEqual(['TURN1', 'https://label.test/f.pdf', 2.5, 'ZZL11F', 'ZZL11F.pdf']);
    expect(fs.readFileSync(labelFile('ZZL11F.pdf'), 'utf8')).toBe('CARRIERLABEL');
    expect((await lastQueueJob()).status).toBe('success');
    expect(events[0]).toMatch(/frayun mass print \d+ started/);
  });

  it('a non-00000 ResultCode frees the order and leaves the job at `start`', async () => {
    await seedOrder('ZZL11F');
    frayunReplies.CreatePreToJson = () => ({ CreatePreToJsonResult: JSON.stringify([{ ResultCode: '10001', DpdNo: '', Total: 0 }]) });
    await processOfficeJob(job('FrayunMassPrintLabel', frayunData));
    expect(await orderStatus('ZZL11F')).toBeNull();
    expect(frayunCalls).toEqual(['CreatePreToJson']);
    expect((await lastQueueJob()).status).toBe('start');
    expect(events.at(-1)).toMatch(/failed: \d+<br>10001<br\/>$/);
  });

  it('a zero weight skips the carrier call and silently leaves the order printing', async () => {
    await seedOrder('ZZL11F');
    await processOfficeJob(job('FrayunMassPrintLabel', { ...frayunData, oz: 0 }));
    expect(frayunCalls).toEqual([]);
    expect(await orderStatus('ZZL11F')).toBe('printing');
    expect((await lastQueueJob()).status).toBe('success');
  });

  it('a SOAP fault fails the job', async () => {
    await seedOrder('ZZL11F');
    frayunReplies.CreatePreToJson = () => {
      throw new FrayunFault('boom');
    };
    await expect(processOfficeJob(job('FrayunMassPrintLabel', frayunData))).rejects.toThrow('boom');
    expect((await lastQueueJob()).status).toBe('failed');
  });
});

describe('DownloadLabel', () => {
  it('stores the carrier URL of a tracking row and records localUrl', async () => {
    const now = NOW;
    const { insertId } = await db.insertInto('os_trackings').values({ orderId: 'ZZL11G', store: 'A', tracking: 'T', Url: 'https://label.test/x.pdf', created_at: now, updated_at: now } as never).executeTakeFirstOrThrow();
    await processOfficeJob(job('DownloadLabel', { trackingId: Number(insertId) }));
    expect((await trackings('ZZL11G'))[0].localUrl).toBe('ZZL11G.pdf');
    expect(fs.readFileSync(labelFile('ZZL11G.pdf'), 'utf8')).toBe('CARRIERLABEL');
  });

  it('a missing tracking row fails the job', async () => {
    await expect(processOfficeJob(job('DownloadLabel', { trackingId: 0 }))).rejects.toThrow(/not found/);
  });
});

describe('DRY_RUN=1', () => {
  it('records the queue rows as dry-run and touches no carrier, order, label or tracking', async () => {
    process.env.DRY_RUN = '1';
    await seedOrder('ZZL11H');
    for (const name of ['MassPrintLabel', 'AmzMassPrintLabel', 'FrayunMassPrintLabel'] as const) {
      await processOfficeJob(job(name, massData(['ZZL11H'])));
      expect((await lastQueueJob()).status).toBe('dry-run');
    }
    await processOfficeJob(job('DownloadLabel', { trackingId: 1 }));
    expect([stampsCalls, frayunCalls, amazonPaths, events]).toEqual([[], [], [], []]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await orderStatus('ZZL11H')).toBeNull();
    expect(await trackings('ZZL11H')).toEqual([]);
  });
});
