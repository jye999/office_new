// Ports of app/Jobs/{MassPrintLabel,AmzMassPrintLabel,FrayunMassPrintLabel,DownloadLabel}.php. Every carrier call goes
// through the Stamps / Frayun / AmazonApi libraries, whose request() seams refuse purchases under DRY_RUN=1; label files
// are fetched with the U6 storeLabel helper. Legacy quirks are kept on purpose (see the comments marked "PHP").
//
// PHP queue semantics: tries = 1, so an exception ends the job and runs failed(); Frayun also has $timeout = 600.
// shortcut: that timeout is only checked between orders (no worker process to kill), upgrade if one order can hang.

import { db, nowDb } from '../db.js';
import { saveChanges } from '../lib/eloquent.js';
import { Frayun, zoneAndDiscountedRate } from '../lib/frayun.js';
import { AmazonApi } from '../lib/amazonApi.js';
import { storeAmazonLabel, storeLabel } from '../lib/labels.js';
import { Stamps } from '../lib/stamps.js';
import { trigger } from '../pusher.js';
import { json_encode, round, substr } from '../view.js';
import { deductStock } from '../modules/unshipped/orders.js';
import { attachProductMaps } from '../modules/unshipped/service.js';
import type { OfficeJobData, OfficeJobName } from './queue.js';

// Carrier SOAP/JSON payloads and DB rows are read the way the PHP read them (dynamic properties).
interface Row {
  [key: string]: any;
}

const FROM_ADDRESS = {
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

const FRAYUN_TIMEOUT_MS = 600_000;

export interface QueueJobRef {
  id: number;
  queueId: number;
}

export function timestamp(): Date {
  // SAFETY: Kysely's generated Date timestamp type accepts Laravel's DB-format string at runtime.
  return nowDb() as unknown as Date;
}

// The PHP jobs use time() rather than the queue's job id, including its same-second collision behaviour.
export async function createQueueJob(type: 'label' | 'ping', status: string): Promise<QueueJobRef> {
  const queueId = Math.floor(Date.now() / 1000);
  const now = timestamp();
  const { insertId } = await db.insertInto('os_queuejobs').values({ queueId, type, status, created_at: now, updated_at: now }).executeTakeFirstOrThrow();
  return { id: Number(insertId), queueId };
}

const setQueueJobStatus = (id: number, status: string) =>
  db.updateTable('os_queuejobs').set({ status, updated_at: timestamp() }).where('id', '=', id).execute();

// event(new LabelDoneEvent($msg)): Laravel broadcasts the public properties on the `label` channel. Broadcasting is
// queued in Laravel, so a Pusher failure never fails the label job.
async function labelDone(result: string): Promise<void> {
  try {
    await trigger('label', 'App\\Events\\LabelDoneEvent', { orders: null, result });
  } catch (e) {
    console.error('LabelDoneEvent broadcast failed:', e);
  }
}

const successMessage = (queueId: number) => `success:  <a target="_blank" href="queue.print?queueId=${queueId}">${queueId} click to print</a>`;

// PHP urlencode(): like encodeURIComponent but space -> '+' and !'()* also escaped.
const phpUrlencode = (s: string): string =>
  encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// PHP loose `$x != null` as the legacy code applies it to product-map quantities.
const present = (v: unknown): boolean => v != null && v !== 0 && v !== '';

function orderIdsOf(data: OfficeJobData): string[] {
  const { orders } = data;
  // whereIn() on a non-array is a PHP TypeError, which fails the job.
  if (Array.isArray(orders)) return orders.map(String);
  if (orders !== null && typeof orders === 'object') return Object.values(orders).map(String);
  throw new TypeError('orders must be an array');
}

const findOrder = async (orderId: string): Promise<Row | undefined> =>
  db.selectFrom('os_grant_order').selectAll().where('orderId', '=', orderId).executeTakeFirst();

const setOrderStatus = async (order: Row, status: string | null) => saveChanges('os_grant_order', order, { status, updated_at: nowDb() });

// GrantOrder::with('detail')->whereIn('orderId', ...)->get(); each order is marked `printing` and linked to the job.
async function takeOrders(data: OfficeJobData, queueId: number): Promise<Row[]> {
  const ids = orderIdsOf(data);
  const orders: Row[] = ids.length ? await db.selectFrom('os_grant_order').selectAll().where('orderId', 'in', ids).execute() : [];
  for (const o of orders) {
    await setOrderStatus(o, 'printing');
    await db.insertInto('os_queuejob_order').values({ jobId: queueId, orderId: o.orderId, created_at: timestamp(), updated_at: timestamp() }).execute();
    o.detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', o.orderId).execute();
  }
  return orders;
}

async function insertTracking(values: Row): Promise<number> {
  const now = timestamp();
  const { insertId } = await db.insertInto('os_trackings').values({ ...values, created_at: now, updated_at: now } as never).executeTakeFirstOrThrow();
  return Number(insertId);
}

// Tracking->save() twice: first without localUrl, then after storeLabel() fetched the carrier URL.
async function storeTrackingLabel(trackingId: number, orderId: string, url: string): Promise<void> {
  const localUrl = await storeLabel(orderId, url);
  await db.updateTable('os_trackings').set({ localUrl, updated_at: timestamp() }).where('Id', '=', trackingId).execute();
}

function shipToAddress(o: Row, nameKey: 'FullName' | 'Name'): Row {
  const address: Row = {
    [nameKey]: o.recipientName,
    Address1: o.address1,
    Address2: o.address2,
    City: String(o.city ?? '').toUpperCase(),
    State: String(o.state ?? '').toUpperCase(),
    ZIPCode: substr(String(o.zip ?? ''), 0, 5),
    PostalCode: o.zip,
    Country: o.country,
    PhoneNumber: o.phone,
  };
  if (address.State.length > 2) address.State = Stamps.getStateAbbr(address.State);
  return address;
}

// ---------------------------------------------------------------- MassPrintLabel (Stamps)

// The only rate the job ever buys: the first US-GA rate of a list, or the single rate Stamps returned.
function rateCode(response: Row): string[] {
  const list = response.Rates?.Rate;
  if (Array.isArray(list)) {
    const rate = list.find((r) => r.ServiceType == 'US-GA');
    return rate ? [phpUrlencode(json_encode(rate))] : [];
  }
  if (list == null) throw new Error('Trying to get property of non-object');
  return [phpUrlencode(json_encode(list))];
}

async function memoOf(o: Row): Promise<string> {
  let memo = `${o.store} `;
  memo += String(o.orderId).length >= 13 ? `${String(o.orderId).slice(-7)} ` : `${o.orderId} `;
  await attachProductMaps(o.detail);
  for (const i of o.detail) {
    const map = i.ProductMap;
    if (map != null) {
      memo += map.sku;
      if (present(map.qty)) memo += `X${map.qty}`;
    }
  }
  return memo;
}

async function massPrintLabel(data: OfficeJobData, job: QueueJobRef): Promise<void> {
  await labelDone(`mass print ${job.queueId} started`);
  const orders = await takeOrders(data, job.queueId);
  const stamps = new Stamps();
  const rated: { order: Row; rate?: { Rates: string[]; Address: unknown } }[] = [];
  for (const o of orders) {
    const ratesResponse = await stamps.getRatesNoCleanse(
      shipToAddress(o, 'FullName'), FROM_ADDRESS, data.lb, data.oz, data.length, data.width, data.height, data.packageType, data.insurance, data.declareValue,
    );
    rated.push(ratesResponse.success == 'true' ? { order: o, rate: { Rates: rateCode(ratesResponse.response), Address: ratesResponse.Address } } : { order: o });
  }

  await labelDone(`mass print ${job.queueId} buying labels`);
  let msg = '';
  for (const { order: o, rate } of rated) {
    if (!rate) {
      // PHP: the failed rate response never reaches the buy loop's isset($rate['rate']) check.
      const order = await findOrder(o.orderId);
      if (order) await setOrderStatus(order, null);
      msg += 'error <br>';
      console.error('rate response failed', o.orderId);
      continue;
    }
    const memo = await memoOf(o);
    // PHP: an empty Rates list is an undefined offset, which fails the job mid-way.
    if (rate.Rates.length === 0) throw new Error('Undefined offset: 0');
    const bought = await stamps.buyLabel(null, rate.Rates[0], FROM_ADDRESS, rate.Address as Row, memo, [], false);
    const order = await findOrder(o.orderId);
    if (bought.success == 'true') {
      if (order) {
        await setOrderStatus(order, 'submit');
        const trackingId = await insertTracking({
          store: order.store,
          orderId: order.orderId,
          tracking: bought.response.TrackingNumber,
          Url: bought.response.URL,
          Amount: bought.response.Rate.Amount,
          stampsTxId: bought.response.StampsTxID,
        });
        await storeTrackingLabel(trackingId, order.orderId, bought.response.URL);
        await deductStock(order.orderId);
      }
    } else {
      if (order) await setOrderStatus(order, null);
      console.error('oops', bought.message);
      msg += `${memo}<br>${bought.message}<br>`;
    }
  }

  // PHP: a job with any failed order keeps status `start`; only a clean run becomes `success`.
  if (msg === '') {
    await setQueueJobStatus(job.id, 'success');
    await labelDone(successMessage(job.queueId));
  } else {
    await labelDone(`failed: ${job.queueId}<br>${msg}`);
  }
}

// ---------------------------------------------------------------- AmzMassPrintLabel (Amazon MFN)

async function amzMassPrintLabel(data: OfficeJobData, job: QueueJobRef): Promise<void> {
  await labelDone(`mass print ${job.queueId} started`);
  const orders = await takeOrders(data, job.queueId);
  const amz = new AmazonApi();
  for (const o of orders) {
    const items = o.detail;
    const services = await amz.getShippingRates(o.orderId, data.length, data.width, data.height, data.oz, items);
    // Cheapest service under $200; null when none (createShipment then fails).
    let lowest = 200.0;
    let shippingServiceId: string | null = null;
    for (const l of services) {
      if (parseFloat(l.rate.amount) < lowest) {
        lowest = parseFloat(l.rate.amount);
        shippingServiceId = l.shipping_service_id;
      }
    }
    // PHP: `catch (Exception $e)` resolves to a non-existent App\Jobs\Exception, so errors are never caught here:
    // they fail the job and leave the order in `printing`.
    const shipment = await amz.createShipment(o.orderId, data.length, data.width, data.height, data.oz, items, shippingServiceId as string);
    await storeAmazonLabel(o.orderId, shipment.label.file_contents.contents);
    const gorder = await findOrder(o.orderId);
    if (gorder) await setOrderStatus(gorder, 'Done');
    await insertTracking({
      orderId: o.orderId,
      store: 'A',
      tracking: shipment.tracking_id,
      Url: shipment.shipment_id,
      localUrl: `${o.orderId}.png`,
      Amount: shipment.shipping_service.rate.amount,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000)); // PHP sleep(1) between purchases
  }
  await setQueueJobStatus(job.id, 'success');
  await labelDone(successMessage(job.queueId));
}

// ---------------------------------------------------------------- FrayunMassPrintLabel

// PHP empty() on request scalars: null, '', '0', 0 -> default.
const orDefault = (v: unknown, dflt: number): string | number => (v == null || v === '' || v === '0' || v === 0 || v === false ? dflt : typeof v === 'number' ? v : String(v));

async function frayunMassPrintLabel(data: OfficeJobData, job: QueueJobRef): Promise<void> {
  await labelDone(`frayun mass print ${job.queueId} started`);
  const deadline = Date.now() + FRAYUN_TIMEOUT_MS;
  const orders = await takeOrders(data, job.queueId);
  const frayun = new Frayun();
  let msg = '';
  for (const o of orders) {
    if (Date.now() > deadline) throw new Error('The job has timed out (600 seconds)');
    const toAddress = shipToAddress(o, 'Name');
    const products = o.detail.map((od: Row) => ({
      ProduceNameCN: substr(String(od.name ?? ''), 0, 50),
      ProduceNameEN: substr(String(od.name ?? ''), 0, 50),
      USD: 100,
      SalePrice: 100,
      Packages: od.qty,
      Sku: od.sku,
      Weight: 0.5,
    }));

    const oz = orDefault(data.oz, 0);
    const lb = orDefault(data.lb, 0);
    const lengthInCm = round(parseFloat(String(orDefault(data.length, 1))) * 2.54 || 0, 2);
    const widthInCm = round(parseFloat(String(orDefault(data.width, 1))) * 2.54 || 0, 2);
    const heightInCm = round(parseFloat(String(orDefault(data.height, 1))) * 2.54 || 0, 2);
    const volWeight = (lengthInCm * widthInCm * heightInCm) / 6000;

    let totalOz = Number(oz) || 0;
    if (Number(lb) >= 1) totalOz = (parseFloat(String(oz)) || 0) + (parseFloat(String(lb)) || 0) * 16;
    const serviceType = totalOz >= 16 ? 'PRIORITY MAIL' : 'FIRST CLASS';
    if (totalOz == 16) totalOz = 18; // 1 lb prints as a 2 lb label
    let weightInKg = 0;
    if (totalOz > 16) {
      weightInKg = totalOz * 0.02835;
      if (volWeight > weightInKg) console.info(`cube weight ${volWeight} bigger than actual weight ${weightInKg}`);
    }
    if (totalOz >= 32 && Math.trunc(totalOz) % 16 == 0) {
      // PHP `%` casts to int; even pounds use 2 less oz
      totalOz -= 2;
      weightInKg = totalOz * 0.02835;
    }
    const { zone, discountedRate } = await zoneAndDiscountedRate(substr(FROM_ADDRESS.ZIPCode, 0, 3), toAddress.ZIPCode, totalOz, serviceType);
    console.info(`discountedRate ${discountedRate}`);
    if (totalOz < 16) weightInKg = Math.floor(totalOz * 28.35) / 1000;
    console.info(`printing ${lb} lb${oz} oz total oz${totalOz} $weightInKg${weightInKg}`);

    // PHP: a zero weight silently skips the order, which stays `printing`.
    if (!(weightInKg > 0)) continue;
    const response: Row[] = JSON.parse(
      await frayun.buyLabel(o.orderId, FROM_ADDRESS, toAddress, o.orderId, nowDb().slice(0, 10), weightInKg, lengthInCm, heightInCm, widthInCm, products),
    );
    const bought = response[0];
    const order = await findOrder(o.orderId);
    if (bought.ResultCode == '00000') {
      if (order) {
        const downloaded: Row[] = JSON.parse(await frayun.downloadLabel(bought.DpdNo));
        await setOrderStatus(order, 'submit');
        const trackingId = await insertTracking({
          store: order.store,
          orderId: order.orderId,
          tracking: downloaded[0].TurnNo,
          Url: downloaded[0].PdfUrl,
          Zone: zone,
          DiscountedRate: discountedRate,
          Amount: bought.Total,
          stampsTxId: order.orderId,
        });
        await storeTrackingLabel(trackingId, order.orderId, downloaded[0].PdfUrl);
        await deductStock(order.orderId);
      }
    } else {
      if (order) await setOrderStatus(order, null);
      msg += `${bought.ResultCode}<br/>`;
      console.error('oops', bought.ResultCode);
    }
  }

  if (msg === '') {
    await setQueueJobStatus(job.id, 'success');
    await labelDone(successMessage(job.queueId));
  } else {
    await labelDone(`failed: ${job.queueId}<br>${msg}`);
  }
}

// ---------------------------------------------------------------- failed() + DownloadLabel + entry point

// MassPrintLabel::failed() also frees `printing` orders, but looks the job's orders up by the queuejob's primary key
// instead of its queueId, so it only touches orders of whichever job row has that queueId. Kept.
async function failed(name: OfficeJobName, currentJob: QueueJobRef): Promise<void> {
  console.info(`${name} failed`);
  await setQueueJobStatus(currentJob.id, 'failed');
  if (name === 'MassPrintLabel') {
    const rows = await db.selectFrom('os_queuejob_order').select('orderId').where('jobId', '=', currentJob.id).execute();
    const ids = rows.map((r) => r.orderId);
    if (ids.length) {
      await db.updateTable('os_grant_order').set({ status: null, updated_at: timestamp() }).where('orderId', 'in', ids).where('status', '=', 'printing').execute();
    }
  }
  await labelDone(`failed:${currentJob.id}`);
}

export async function runLabelJob(name: 'MassPrintLabel' | 'AmzMassPrintLabel' | 'FrayunMassPrintLabel', data: OfficeJobData): Promise<void> {
  const job = await createQueueJob('label', 'start');
  const run = { MassPrintLabel: massPrintLabel, AmzMassPrintLabel: amzMassPrintLabel, FrayunMassPrintLabel: frayunMassPrintLabel }[name];
  try {
    await run(data, job);
  } catch (e) {
    await failed(name, job);
    throw e;
  }
}

// DownloadLabel: copies the carrier URL of a tracking row into the labels disk. A missing row is a PHP null dereference.
export async function downloadLabel(data: OfficeJobData): Promise<void> {
  const tracking = await db.selectFrom('os_trackings').select(['Id', 'orderId', 'Url']).where('Id', '=', Number(data.trackingId)).executeTakeFirst();
  if (!tracking) throw new Error(`DownloadLabel: tracking ${String(data.trackingId)} not found`);
  await storeTrackingLabel(tracking.Id, tracking.orderId, tracking.Url);
}
