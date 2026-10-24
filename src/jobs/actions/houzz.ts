// J5: Runner.php `houzz` action (ShipHouzz then GetHouzz), scheduled in Kernel.php. Houzz's read-only
// order/product GETs and every DB write are skipped under DRY_RUN=1 at the action level.

import { db, nowDb } from '../../db.js';
import { Houzz } from '../../lib/houzz.js';
import { date, strtotime } from '../../view.js';

const dryRun = () => process.env.DRY_RUN === '1';

// json_decode($raw, true) then `$result['Ack']`: a non-array reply makes PHP raise (Laravel ErrorException).
function decode(raw: string | false): any {
  let v: any = null;
  try { v = JSON.parse(String(raw)); } catch { /* json_decode failure -> null */ }
  if (v === null || typeof v !== 'object') throw new Error('Trying to access array offset on value of type null');
  return v;
}

// ShipHouzz: every Houzz-shipped order not already Done (any store, like PHP) becomes Done.
async function shipHouzz(houzz: Houzz): Promise<void> {
  const result = decode(await houzz.getShippedOrders());
  if (result.Ack === 'Success' && result.Orders != null) {
    for (const o of result.Orders) {
      await db
        .updateTable('os_grant_order')
        .set({ status: 'Done', updated_at: nowDb() as never })
        .where('orderId', '=', String(o.OrderId))
        .where((eb) => eb.or([eb('status', '<>', 'Done'), eb('status', 'is', null)]))
        .execute();
    }
  }
}

async function getHouzz(houzz: Houzz): Promise<void> {
  const ao: Record<string, unknown>[] = [];
  const aod: Record<string, unknown>[] = [];
  const result = decode(await houzz.getUnshippedOrders());
  if (result.Ack === 'Success' && result.Orders != null) {
    for (const o of result.Orders) {
      const existing = await db.selectFrom('os_grant_order').select('id').where('orderId', '=', String(o.OrderId)).where('store', '=', 'H').executeTakeFirst();
      if (existing) continue;
      const created = date('Y-m-d H:i:s', strtotime(o.Created));
      ao.push({
        orderId: o.OrderId, store: 'H', purchaseDate: created, paymentDate: created, buyer: o.CustomerName, email: o.CustomerName,
        recipientName: o.CustomerName, address1: o.Address.Address1, address2: o.Address.Address2 ?? '', city: o.Address.City,
        state: o.Address.State, zip: o.Address.Zip, country: 'US', total: o.OrderTotal,
      });
      for (const ol of o.OrderItems) {
        const product = decode(await houzz.getProduct(ol.ProductId));
        let image = '';
        if (product.Ack === 'Success') {
          const osProduct = await db.selectFrom('os_products').select('id').where('amazon_sku', '=', ol.SKU).executeTakeFirst();
          const osImage = osProduct && (await db
            .selectFrom('os_product_images').select('filename').where('product_id', '=', String(osProduct.id)).where('filename', 'like', '%main%').executeTakeFirst());
          if (osImage) image = osImage.filename;
        }
        aod.push({
          orderId: o.OrderId, subOrderId: ol.ProductId, store: 'H', itemId: ol.SKU, name: ol.Title, qty: Math.trunc(Number(ol.Quantity)) || 0,
          image, asin: ol.SKU, price: ol.Cost,
          // PHP bug kept: strtotime(strtotime(...)) is false, so date() prints the epoch (1970-01-01 UTC) in local time.
          promiseDate: date('Y-m-d H:i:s', 0),
        });
      }
    }
    if (ao.length > 0) await db.insertInto('os_grant_order').values(ao as never).execute();
    if (aod.length > 0) await db.insertInto('os_grant_orderdetail').values(aod as never).execute();
  }
  console.info(`houzz done , new orders : ${ao.length}`);
}

export const houzzActions: Record<string, (arg1?: string) => Promise<number>> = {
  houzz: async () => {
    if (dryRun()) {
      console.info('[DRY_RUN] sync houzz: Houzz request and DB writes skipped');
      return 0;
    }
    const houzz = new Houzz();
    await shipHouzz(houzz);
    await getHouzz(houzz);
    return 0;
  },
};
