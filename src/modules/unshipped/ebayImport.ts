// UnshippedController::loadeBayOrderIntoDB() — eBay GetSellingManagerSoldListings -> os_grant_order / os_grant_orderdetail.
// Also the entry point the scheduled Runner job uses (same cache throttle). Reads from eBay only (no write verbs).
//
// SimpleXML quirks kept (verified on php:7.4): `$node->X != null` is TRUE for every element (even a missing one),
// `(string)` of a missing element is '', the detail `promiseDate` is strtotime(strtotime(..)) = 1969-12-31 19:00:00 (NY).

import { db } from '../../db.js';
import { cacheGet, cacheHas, cachePut } from '../../lib/cache.js';
import { Ebay } from '../../lib/ebay.js';
import { sxGet, sxList, sxText, sxBool, sxIsset, phpStrEq, type Sx } from '../../lib/simplexml.js';
import { saveChanges } from '../../lib/eloquent.js';
import { date, strtotime } from '../../view.js';

type Rec = Record<string, string | number>;
const T = (n: Sx, ...path: string[]): string => sxText(sxGet(n, ...path));
const ymdHis = (s: string): string => date('Y-m-d H:i:s', strtotime(s));

// Builder::insert($rows): every row is ksort()ed, the column list comes from the first row and the bindings are
// the flattened rows. Rows with different keys therefore mismatch the placeholder count (PDO error -> 500).
async function laravelInsert(table: 'os_grant_order' | 'os_grant_orderdetail', rows: Rec[]): Promise<void> {
  if (rows.length === 0) return;
  const sorted = rows.map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  const cols = Object.keys(sorted[0]);
  if (sorted.some((r) => Object.keys(r).length !== cols.length)) throw new Error('SQLSTATE[HY093]: Invalid parameter number');
  const values = sorted.map((r) => Object.fromEntries(cols.map((c, i) => [c, Object.values(r)[i]])));
  // SAFETY: column names are the literal keys built below; values are bound by Kysely.
  await db.insertInto(table).values(values as never).execute();
}

export async function loadEbayOrdersIntoDb(ebay: Ebay = new Ebay()): Promise<string> {
  const cacheMinute = 5;
  const nowStr = date('Y-m-d H:i:s');
  if (await cacheHas('ebayRequestTime')) {
    const last = strtotime(String(await cacheGet('ebayRequestTime')));
    const secs = Math.abs(strtotime(nowStr) - last);
    // DateInterval->i is only the minutes component of the difference.
    if (Math.floor((secs % 3600) / 60) < cacheMinute) return 'OK';
  }
  let page = 1;
  let totalPages = 1;
  await cachePut('ebayRequestTime', nowStr, 5);
  let result = await ebay.awaitingShipment2(page);
  const orderIds: string[] = [];

  while (page <= totalPages) {
    totalPages = 0;
    page++;
    if (T(result, 'Ack') === 'Success') {
      totalPages = parseInt(T(result, 'PaginationResult', 'TotalNumberOfPages'), 10) || 0;
      for (const sRecord of sxList(sxGet(result, 'SaleRecord'))) {
        if (!phpStrEq(T(sRecord, 'OrderStatus', 'CheckoutStatus'), 'CheckoutComplete')) continue;
        const saleId = T(sRecord, 'SaleRecordID');
        orderIds.push(saleId);
        const existing = await db.selectFrom('os_grant_order').select('id').where('orderId', '=', saleId).where('store', '=', 'E').limit(1).executeTakeFirst();
        if (existing) continue;
        const co: Rec = {
          orderid: saleId,
          store: 'E',
          purchaseDate: ymdHis(T(sRecord, 'CreationTime')),
          paymentDate: ymdHis(T(sRecord, 'OrderStatus', 'PaidTime')),
          buyer: T(sRecord, 'BuyerID'),
          email: T(sRecord, 'BuyerEmail'),
          recipientName: T(sRecord, 'ShippingAddress', 'Name'),
          zip: T(sRecord, 'ShippingAddress', 'PostalCode'),
          total: T(sRecord, 'TotalAmount'),
        };
        let noteFromBuyer = '';
        let selfNotes = '';
        const aod: Rec[] = [];
        for (const rec of sxList(sxGet(sRecord, 'SellingManagerSoldTransaction'))) {
          const lineId = T(rec, 'OrderLineItemID');
          const od = await db
            .selectFrom('os_grant_orderdetail')
            .select('id')
            .where('orderId', '=', saleId)
            .where('subOrderId', '=', T(rec, 'SaleRecordID'))
            .where('store', '=', 'E')
            .where('itemId', '=', lineId)
            .limit(1)
            .executeTakeFirst();
          if (od) continue;
          const itemID = lineId.split('-');
          if (itemID.length < 2) throw new Error('Undefined offset: 1'); // $itemID[1] below
          const cod: Rec = {
            orderid: saleId,
            subOrderId: T(rec, 'SaleRecordID'),
            store: 'E',
            itemId: lineId,
            name: T(rec, 'ItemTitle'),
            qty: parseInt(T(rec, 'QuantitySold'), 10) || 0,
            image: `http://galleryplus.ebayimg.com/ws/web/${T(rec, 'ItemID')}_1_0_1/1000x1000.jpg`,
            asin: itemID[0],
            promiseDate: date('Y-m-d H:i:s', strtotime('')), // strtotime(strtotime(..)) is false
          };
          const detail = await ebay.getSaleRecordDetail(itemID[1], itemID[0]);
          if (T(detail, 'Ack') === 'Success') {
            const sold = sxGet(detail, 'SellingManagerSoldOrder');
            if (sxIsset(sxGet(sold, 'NotesFromBuyer'))) noteFromBuyer += T(sold, 'NotesFromBuyer');
            if (sxIsset(sxGet(sold, 'NotesToSeller'))) selfNotes += T(sold, 'NotesToSeller');
            // `ShippingAddress != null` is always true for a SimpleXMLElement
            const addr = (n: Sx) => {
              co['recipientName'] = T(n, 'Name');
              co['address1'] = T(n, 'Street1');
              co['address2'] = T(n, 'Street2');
              co['city'] = T(n, 'CityName');
              co['state'] = T(n, 'StateOrProvince');
              co['zip'] = T(n, 'PostalCode');
              co['country'] = T(n, 'Country');
            };
            addr(sxGet(sold, 'ShippingAddress'));
            if (co['address1'] === undefined || co['address1'] === '') {
              const orderDetail = await ebay.getOrder(lineId);
              if (T(orderDetail, 'Ack') === 'Success') addr(sxGet(sxList(sxGet(orderDetail, 'OrderArray'))[0], 'Order', 'ShippingAddress'));
            }
            cod['price'] = T(sold, 'TotalAmount');
          }
          co['notesFromBuyer'] = noteFromBuyer;
          co['selfNotes'] = selfNotes;
          cod['variation'] = '';
          if (sxBool(sxGet(rec, 'Variation'))) {
            const nv = sxGet(rec, 'Variation', 'VariationSpecifics', 'NameValueList');
            cod['variation'] = `${sxText(sxGet(nv, 'Name'))}|${sxText(sxGet(nv, 'Value'))}`;
          }
          aod.push(cod);
        }
        await laravelInsert('os_grant_order', [co]);
        await laravelInsert('os_grant_orderdetail', aod);
      }
    }
    result = await ebay.awaitingShipment2(page);
  }

  // Orders no longer awaiting shipment: Done once eBay reports them Completed.
  const orders = await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'E').execute();
  for (const od of orders) {
    if (orderIds.includes(od.orderId as string)) continue;
    const details = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', od.orderId as string).execute();
    for (const odd of details) {
      const orderDetail = await ebay.getOrder(odd.itemId);
      if (T(orderDetail, 'Ack') === 'Success' && phpStrEq(T(sxList(sxGet(orderDetail, 'OrderArray'))[0], 'Order', 'OrderStatus'), 'Completed')) {
        await saveChanges('os_grant_order', od as never, { status: 'Done', updated_at: date('Y-m-d H:i:s') });
      }
    }
  }
  return 'OK';
}
