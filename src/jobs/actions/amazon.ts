// J2: Runner.php actions matching /amazon|amz|fba|merchant-listing|amazon-orders/.
// SP-API report requests are reads; every DB/file write below is skipped under
// DRY_RUN=1 at the action level (the J1 lib only gates SP-API write operations).
// The retired MWS BatchUploadAmazon (upload-amz-tracking) is intentionally not
// ported: U8 already records that path as a safe 500.

import { sql } from 'kysely';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { db, nowDb } from '../../db.js';
import { AmazonApi } from '../../lib/amazonApi.js';
import { fetchU10Url } from '../../modules/unshipped/service.js';

type Row = Record<string, unknown>;

const dryRun = () => process.env.DRY_RUN === '1';
const quietDryRun = (action: string) => {
  console.info(`[DRY_RUN] sync ${action}: Amazon request and DB writes skipped`);
  return 0;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// PHP: date('Y-m-d H:i:s', strtotime($x)) in the app timezone; false -> epoch.
function reportDate(value: unknown): string {
  const source = String(value ?? '');
  const plusDay = /\s\+1 day$/.test(source);
  const stamp = Date.parse(source.replace(/\s\+1 day$/, ''));
  return Number.isNaN(stamp) ? '1970-01-01 00:00:00' : nowDb(new Date(stamp + (plusDay ? 86_400_000 : 0)));
}

// getAmzUnshippedItems / GetAmazonOrdersReport / FBA report parsers: first line is
// the header, data rows must have the same field count (and >1 field).
function reportRows(report: string, trimHeaders = false, limit?: number): Row[] {
  const lines = report.split(/\r\n|\n|\r/);
  const header = lines.shift()?.split('\t').map((field) => (trimHeaders ? field.trim() : field)) ?? [];
  const rows: Row[] = [];
  for (const line of lines) {
    const values = line.split('\t');
    if (values.length > 1 && values.length === header.length) {
      rows.push(Object.fromEntries(header.slice(0, limit).map((field, i) => [field, values[i]])));
    }
  }
  return rows;
}

// GetAmzOrderReport(): 18-column slice with no header-length check (unlike the parsers above).
function orderReportRows(report: string): Row[] {
  const lines = report.split(/\r\n|\n|\r/);
  const header = lines.shift()?.split('\t') ?? [];
  return lines
    .map((line) => line.split('\t'))
    .filter((values) => values.length > 1)
    .map((values) => Object.fromEntries(header.slice(0, 18).map((field, i) => [field, values[i]])));
}

export function fbaInventoryRows(rows: Row[]): Row[] {
  // GetFBAInventoryReport header rename; the 18-column slice comes from the parser limit.
  const names: Record<string, string> = {
    'seller-sku': 'sku', 'fulfillment-channel-sku': 'afnsku', asin: 'asin', 'condition-type': 'conditionType',
    'Warehouse-Condition-code': 'warehouseCondition', 'Quantity Available': 'qty',
  };
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([field, value]) => [names[field] ?? field, value])));
}

// getItemImageBySku(): '' for an empty sku; the legacy getListing() returns null
// (and echoes) on API failure, so a fetch failure is also ''.
export async function listingImage(sku: unknown): Promise<string> {
  if (sku == null || String(sku).trim() === '') return '';
  try {
    const listing = await new AmazonApi().getListing(String(sku));
    const image = listing?.attributes?.main_product_image_locator?.[0]?.media_location;
    return typeof image === 'string' ? image : '';
  } catch (e) {
    console.error('Exception when calling ListingsV20210801Api->getListingsItem:', (e as Error).message);
    return '';
  }
}

// One FBA-style report fetch: latest DONE request, document body as TSV rows.
// completedAt is the list's CompletedDate equivalent (what legacy stores in lastupdate).
async function reportDocument(api: AmazonApi, reportType: string, limit?: number): Promise<{ requestId: string; completedAt: string; rows: Row[] }> {
  const reports = await api.getReportRequestList(reportType, 'DONE', '1');
  const report = reports.reports?.[0];
  const document = await api.getReportDocument(report?.report_document_id, report?.report_type ?? reportType);
  const body = await fetchU10Url(document.url);
  const t = Date.parse(String(report?.completed_time ?? ''));
  return {
    requestId: String(report?.report_id ?? ''),
    completedAt: Number.isNaN(t) ? nowDb() : nowDb(new Date(t)),
    rows: reportRows(body, false, limit),
  };
}

// RequestAmzReport(): record the request in os_report_time. SP-API has no
// SubmittedDate; created_time plays that role.
async function requestReport(reportName: string, startDate?: string): Promise<void> {
  const api = new AmazonApi();
  const result = await api.requestReport(reportName, startDate ?? null, api.getFormattedTimestamp());
  const now = nowDb();
  const t = Date.parse(String(result.created_time ?? ''));
  const existing = await db.selectFrom('os_report_time').select('id').where('reportName', '=', reportName).executeTakeFirst();
  const values = {
    requestId: String(result.report_id ?? ''),
    requestTime: (Number.isNaN(t) ? now : nowDb(new Date(t))) as never,
    updated_at: now as never,
  };
  if (existing) {
    await db.updateTable('os_report_time').set(values).where('id', '=', existing.id).execute();
  } else {
    await db.insertInto('os_report_time').values({ ...values, reportName, created_at: now as never }).execute();
  }
}

async function replaceReport(table: 'os_AFN_INVENTORY' | 'os_FBA_AGE' | 'os_MERCHANT_LISTING', reportName: string, limit: number, map: (rows: Row[]) => Row[] = (rows) => rows, truncateBeforeRequest = false): Promise<void> {
  const time = await db.selectFrom('os_report_time').selectAll().where('reportName', '=', reportName).executeTakeFirst();
  if (!time || (time.lastupdate != null && String(time.requestTime) < String(time.lastupdate))) return;
  // Merchant listings truncate before checking whether Amazon returned the requested report.
  if (truncateBeforeRequest) {
    await db.deleteFrom(table).execute();
    await sql`ALTER TABLE os_MERCHANT_LISTING AUTO_INCREMENT = 1`.execute(db);
  }
  const report = await reportDocument(new AmazonApi(), reportName, limit);
  if (String(time.requestId ?? '') !== report.requestId) return;
  const rows = map(report.rows);
  if (!truncateBeforeRequest) await db.deleteFrom(table).execute();
  if (rows.length) await db.insertInto(table).values(rows as never).execute();
  await db.updateTable('os_report_time').set({ lastupdate: report.completedAt as never, updated_at: nowDb() as never }).where('id', '=', time.id).execute();
}

const orderColumns = new Set([
  'amazon-order-id', 'merchant-order-id', 'purchase-date', 'last-updated-date', 'order-status', 'fulfillment-channel', 'sales-channel',
  'order-channel', 'url', 'ship-service-level', 'product-name', 'sku', 'asin', 'item-status', 'quantity', 'currency', 'item-price',
  'item-tax', 'shipping-price', 'shipping-tax', 'gift-wrap-price', 'gift-wrap-tax', 'item-promotion-discount', 'ship-promotion-discount',
  'ship-city', 'ship-state', 'ship-postal-code', 'ship-country', 'promotion-ids', 'is-business-order',
]);

// GetAmazonOrdersReport(): insert new rows, update changed status columns (the
// AmazonOrder model disables Eloquent timestamps), then the raw price join.
export async function storeAmazonOrders(rows: Row[]): Promise<void> {
  const ids = rows.map((row) => row['amazon-order-id']).filter((id): id is string => typeof id === 'string');
  const old = ids.length ? await db.selectFrom('os_AMZ_ORDERS').selectAll().where('amazon-order-id', 'in', ids).execute() : [];
  for (const row of rows) {
    const found = old.find((order) => order['amazon-order-id'] === row['amazon-order-id'] && order.sku === row.sku);
    if (!found) {
      const value = Object.fromEntries(Object.entries(row).filter(([key]) => orderColumns.has(key)));
      delete value.cpf;
      await db.insertInto('os_AMZ_ORDERS').values(value as never).execute();
    } else if (found['last-updated-date'] !== row['last-updated-date'] || found['order-status'] !== row['order-status'] || found['item-status'] !== row['item-status']) {
      await db.updateTable('os_AMZ_ORDERS')
        .set({
          'last-updated-date': String(row['last-updated-date'] ?? ''),
          'order-status': String(row['order-status'] ?? ''),
          'item-status': String(row['item-status'] ?? ''),
        })
        .where('id', '=', found.id).execute();
    }
  }
  await sql`update os_AMZ_ORDERS oao inner join os_grant_orderdetail ogo
    on oao.\`amazon-order-id\`=ogo.orderId and oao.\`product-name\`=ogo.name and oao.\`quantity\`=ogo.qty
    set price=(oao.\`item-price\`+oao.\`item-tax\`+oao.\`shipping-price\`+oao.\`shipping-tax\`+oao.\`gift-wrap-tax\`+oao.\`gift-wrap-tax\`-oao.\`item-promotion-discount\`-oao.\`ship-promotion-discount\`)
    where ogo.store='A' and ogo.price is null`.execute(db);
}

export async function getAmazonOrders(): Promise<void> {
  const api = new AmazonApi();
  const request = await api.requestReport('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', api.getPriorDays(29), api.getFormattedTimestamp());
  const requestId = String(request.report_id ?? '');
  for (let counter = 0; counter < 10; counter++) {
    const reports = await api.getReportRequestList('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL');
    const report = reports.reports?.find((item: { report_id?: string }) => item.report_id === requestId);
    if (!report?.report_document_id) {
      await sleep(60_000); // legacy polls with sleep(60) while the document is not ready
      continue;
    }
    const document = await api.getReportDocument(report.report_document_id, String(report.report_type ?? ''));
    await storeAmazonOrders(reportRows(await fetchU10Url(document.url), true, 29));
    return;
  }
}

// GetAmzOrderReport(): the Runner variant of the U10 helper (…_LAST_UPDATE_GENERAL,
// polled against the exact requested report id).
export async function getAmzOrderReport(): Promise<Row[]> {
  const api = new AmazonApi();
  const request = await api.requestReport('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL', api.getPriorDays(29), api.getFormattedTimestamp());
  const requestId = String(request.report_id ?? '');
  for (let counter = 0; counter < 10; counter++) {
    const reports = await api.getReportRequestList('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL');
    const report = reports.reports?.find((item: { report_id?: string }) => item.report_id === requestId);
    if (report?.report_document_id) {
      const document = await api.getReportDocument(report.report_document_id, String(report.report_type ?? ''));
      return orderReportRows(await fetchU10Url(document.url));
    }
    await sleep(60_000);
  }
  throw new Error('no report found.');
}

// UpdateAmzShipped(). BatchUploadAmazon is retired MWS: the legacy calls it once
// for every row after an unshipped order has tracking; log it instead of sending.
export async function updateAmazonShipped(): Promise<void> {
  let unshipped = 0;
  try {
    for (const row of await getAmzOrderReport()) {
      const order = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', String(row['amazon-order-id'] ?? '')).executeTakeFirst();
      if (!order) continue;
      const now = nowDb() as never;
      if (row['order-status'] === 'Shipped' && order.status !== 'Done') {
        await db.updateTable('os_grant_order').set({ status: 'Done', updated_at: now }).where('id', '=', order.id).execute();
      } else if (row['order-status'] === 'Cancelled' && order.status !== 'Cancelled') {
        await db.updateTable('os_grant_order').set({ status: 'Cancelled', updated_at: now }).where('id', '=', order.id).execute();
      } else if (row['order-status'] === 'Unshipped') {
        const tracking = await db.selectFrom('os_trackings').select('Id').where('orderId', '=', order.orderId).executeTakeFirst();
        if (tracking) {
          await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: now }).where('id', '=', order.id).execute();
          unshipped++;
        }
      }
      if (unshipped > 0) console.info('[DRY_RUN] upload-amz-tracking: retired MWS feed not sent');
    }
  } catch (e) {
    // Legacy prints and logs the message, then the command succeeds.
    console.error('update amz shipped exception', (e as Error).message);
  }
}

// DownloadAmzImageAndUpdateOrder(): sets the (possibly empty) image on every
// matching detail and inventory row, and only writes the file when non-empty.
export async function refreshImageByAsin(asin: string): Promise<void> {
  const details = await db
    .selectFrom('os_grant_orderdetail')
    .innerJoin('os_grant_order', 'os_grant_order.orderId', 'os_grant_orderdetail.orderId')
    .select(['os_grant_orderdetail.id', 'os_grant_orderdetail.sku', 'os_grant_orderdetail.image'])
    .where('os_grant_order.store', '=', 'A')
    .where('os_grant_order.status', 'is', null)
    .where('os_grant_orderdetail.asin', '=', asin)
    .execute();
  for (const detail of details) {
    const imageUrl = await listingImage(detail.sku);
    if (imageUrl !== '') {
      const file = path.join(config.PUBLIC_DIR, 'images', `${asin}.jpg`);
      writeFileSync(file, await fetchU10Url(imageUrl));
      chmodSync(file, 0o666);
    }
    if (String(detail.image ?? '') !== imageUrl) {
      await db.updateTable('os_grant_orderdetail').set({ image: imageUrl, updated_at: nowDb() as never }).where('id', '=', detail.id).execute();
    }
    await db.updateTable('os_grant_inventory').set({ image: imageUrl, updated_at: nowDb() as never }).where('asin', '=', asin).execute();
  }
}

export async function getAmzUnshippedItems(): Promise<Row[]> {
  const api = new AmazonApi();
  const request = await api.requestReport();
  const requestId = String(request.report_id ?? '');
  for (let counter = 0; counter < 10; counter++) {
    const reports = await api.getReportRequestList();
    const report = reports.reports?.find((item: { report_id?: string }) => item.report_id === requestId);
    if (!report?.report_document_id) {
      await sleep(60_000);
      continue;
    }
    const document = await api.getReportDocument(report.report_document_id, String(report.report_type ?? ''));
    const items = reportRows(await fetchU10Url(document.url));
    for (const item of items) {
      const inventory = await db.selectFrom('os_grant_inventory').select(['asin', 'image']).where('sku', '=', String(item.sku ?? '')).orderBy('created_at', 'desc').executeTakeFirst();
      if (inventory) {
        item.ASIN = inventory.asin;
        // PHP str_replace drops the 'http(s):' scheme only, keeping '//'.
        item.pic = String(inventory.image ?? '').replace(/https?:/g, '');
      }
    }
    return items;
  }
  throw new Error('no report found.');
}

// ReloadAmzImage(): refetch listing images for store A orders with null status.
async function reloadAmazonImages(): Promise<void> {
  const details = await db
    .selectFrom('os_grant_orderdetail')
    .innerJoin('os_grant_order', 'os_grant_order.orderId', 'os_grant_orderdetail.orderId')
    .select(['os_grant_orderdetail.id', 'os_grant_orderdetail.sku'])
    .where('os_grant_order.store', '=', 'A')
    .where('os_grant_order.status', 'is', null)
    .execute();
  for (const detail of details) {
    const image = await listingImage(detail.sku);
    if (image !== '') {
      await db.updateTable('os_grant_orderdetail').set({ image, updated_at: nowDb() as never }).where('id', '=', detail.id).execute();
    }
  }
}

// GetAmz().
async function getAmz(): Promise<void> {
  const items = await getAmzUnshippedItems();
  const orderIds = items.map((item) => String(item['order-id'] ?? ''));
  const createdOrders = new Set<string>();
  const existing = await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'A').execute();
  for (const order of existing) {
    if (order.status !== 'Done' && !orderIds.includes(order.orderId)) {
      await db.updateTable('os_grant_order').set({ status: 'Done', selfNotes: 'mark done from runner', updated_at: nowDb() as never }).where('id', '=', order.id).execute();
    }
  }
  for (const item of items) {
    const orderId = String(item['order-id'] ?? '');
    // Legacy bulk-inserts orders at the end of the loop, so per-item lookups
    // never see the rows this run is about to create.
    const order = existing.find((o) => o.orderId === orderId);
    if (order && order.PendingShipment !== 1) {
      const tracked = await db.selectFrom('os_trackings').select('Id').where('orderId', '=', orderId).executeTakeFirst();
      if (tracked) await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: nowDb() as never }).where('id', '=', order.id).execute();
    }
    if (!order) {
      // in_array($co, $ao) dedupes items of the same order: one row per order.
      if (!createdOrders.has(orderId)) {
        await db.insertInto('os_grant_order').values({
          orderId, store: 'A', purchaseDate: reportDate(item['purchase-date']), paymentDate: reportDate(item['payments-date']), buyer: String(item['recipient-name'] ?? ''),
          email: String(item['buyer-email'] ?? ''), phone: String(item['buyer-phone-number'] ?? ''), recipientName: String(item['recipient-name'] ?? ''),
          address1: String(item['ship-address-1'] ?? ''), address2: `${item['ship-address-2'] ?? ''} ${item['ship-address-3'] ?? ''}`,
          city: String(item['ship-city'] ?? ''), state: String(item['ship-state'] ?? ''), zip: String(item['ship-postal-code'] ?? ''), country: String(item['ship-country'] ?? ''),
          // Legacy quirk: total = ship-country; PHP coerces 'US' to 0.
          total: Number(item['ship-country'] ?? 0) || 0,
        } as never).execute();
        createdOrders.add(orderId);
      }
      const itemId = String(item['order-item-id'] ?? '');
      const detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', orderId).where('itemId', '=', itemId).executeTakeFirst();
      if (!detail) {
        await db.insertInto('os_grant_orderdetail').values({
          orderId, store: 'A', itemId, name: String(item['product-name'] ?? ''), qty: Number(item['quantity-purchased'] ?? 0),
          image: String(item.pic ?? ''), asin: String(item.ASIN ?? ''),
          promiseDate: item['is-prime'] === 'true' ? reportDate(`${String(item['purchase-date'] ?? '')} +1 day`) : reportDate(item['promise-date']),
          shipLevel: String(item['ship-service-level'] ?? ''), isPrime: String(item['is-prime'] ?? ''), sku: String(item.sku ?? ''),
          notes: `${item['is-buyer-requested-cancellation'] === 'true' ? ' buyer cancel' : ''}${item['is-replacement-order'] === 'true' ? ' replacement order' : ''}`,
        } as never).execute();
      } else if (String(detail.asin ?? '') === '' || String(detail.image ?? '') === '') {
        const set: Record<string, unknown> = {};
        if (item.ASIN !== undefined) set.asin = String(item.ASIN);
        if (item.pic !== undefined) set.image = String(item.pic);
        // Eloquent save() is a no-op when nothing is dirty.
        if (Object.keys(set).length) {
          await db.updateTable('os_grant_orderdetail').set({ ...set, updated_at: nowDb() as never } as never).where('id', '=', detail.id).execute();
        }
      }
    } else if (order.status == null) {
      for (const [flag, marker] of [['is-buyer-requested-cancellation', 'buyer cancel'], ['is-replacement-order', 'replacement order']] as const) {
        if (item[flag] !== 'true') continue;
        const details = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', orderId).where('itemId', '=', String(item['order-item-id'] ?? '')).execute();
        for (const detail of details) {
          if (String(detail.notes ?? '').includes(marker)) continue;
          await db.updateTable('os_grant_orderdetail').set({ notes: `${detail.notes ?? ''}${marker}`, updated_at: nowDb() as never }).where('id', '=', detail.id).execute();
        }
      }
    }
  }
  const unshipped = await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'A').where('status', 'is', null).execute();
  for (const order of unshipped) {
    if (orderIds.includes(order.orderId)) continue;
    // status IS NULL already excludes 'Shipped'/'submit' (the legacy checks are dead).
    await db.updateTable('os_grant_order').set({ status: 'Done', selfNotes: 'mark done from runner2', updated_at: nowDb() as never }).where('id', '=', order.id).execute();
  }
}

// 'sync amazon': GetAmz() then ReloadAmzImage(); GetAmz swallows its exceptions.
async function amazon(): Promise<void> {
  try {
    await getAmz();
  } catch (e) {
    console.error('exception no report', (e as Error).message);
  }
  await reloadAmazonImages();
}

export const amazonActions: Record<string, (arg1?: string) => Promise<number>> = {
  amazon: async () => { if (dryRun()) return quietDryRun('amazon'); await amazon(); return 0; },
  // Runner's dispatch leaves this body commented out; the scheduled invocation is a no-op.
  'request-amazon-orders-report': async () => 0,
  'get-amazon-orders-report': async () => { if (dryRun()) return quietDryRun('get-amazon-orders-report'); await getAmazonOrders(); return 0; },
  'update-amz-shipped': async () => { if (dryRun()) return quietDryRun('update-amz-shipped'); await updateAmazonShipped(); return 0; },
  'get-amz-image-by-asin': async (asin) => { if (dryRun()) return quietDryRun('get-amz-image-by-asin'); await refreshImageByAsin(String(asin ?? '')); return 0; },
  'request-fba-inventory-report': async () => { if (dryRun()) return quietDryRun('request-fba-inventory-report'); await requestReport('_GET_AFN_INVENTORY_DATA_'); return 0; },
  'get-fba-inventory-report': async () => { if (dryRun()) return quietDryRun('get-fba-inventory-report'); await replaceReport('os_AFN_INVENTORY', '_GET_AFN_INVENTORY_DATA_', 18, fbaInventoryRows); return 0; },
  'request-merchant-listing-report': async () => { if (dryRun()) return quietDryRun('request-merchant-listing-report'); await requestReport('_GET_MERCHANT_LISTINGS_ALL_DATA_'); return 0; },
  'get-merchant-listing-report': async () => { if (dryRun()) return quietDryRun('get-merchant-listing-report'); await replaceReport('os_MERCHANT_LISTING', '_GET_MERCHANT_LISTINGS_ALL_DATA_', 27, undefined, true); return 0; },
  // These two branches are commented out in Runner.php itself.
  'request-fba-health-report': async () => 0,
  'get-fba-health-report': async () => 0,
  'request-fba-age-report': async () => { if (dryRun()) return quietDryRun('request-fba-age-report'); const api = new AmazonApi(); await requestReport('_GET_FBA_INVENTORY_AGED_DATA_', api.getPriorDays(2)); return 0; },
  'get-fba-age-report': async () => { if (dryRun()) return quietDryRun('get-fba-age-report'); await replaceReport('os_FBA_AGE', '_GET_FBA_INVENTORY_AGED_DATA_', 18); return 0; },
};
