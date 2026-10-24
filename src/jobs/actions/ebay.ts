// J3: Runner.php actions matching /ebay|raystore/ that are scheduled (uncommented) in
// Kernel.php: upload-ebay-tracking (EbayApiHelper::BatchUploadeBay),
// upload-ray-ebay-tracking (EbayHelper::BatchUploadRayeBay), update-ebay-handling
// (EbayHelper::UpdateebayHandling). The other /ebay|raystore/ branches (ebay, raystore,
// ebay-orders, ebay-item, ebay-token, get-ebay-listing, get-ebay-listing-desc) are not
// scheduled and no route/page invokes them (grep of the action names), so they stay
// unregistered and fall through to Runner's silent unknown-action no-op.
// Every eBay request and DB write below is skipped under DRY_RUN=1 at the action level.

import { db, nowDb } from '../../db.js';
import { sendMail } from '../../mail.js';
import { Ebay, xmlText } from '../../lib/ebay.js';
import { EbayApi } from '../../lib/ebayApi.js';

const dryRun = () => process.env.DRY_RUN === '1';
const quietDryRun = (action: string) => {
  console.info(`[DRY_RUN] sync ${action}: eBay request and DB writes skipped`);
  return 0;
};

// PHP 7 loose `!= null`: only null, '' and '0' compare equal to null.
const notPhpNull = (v: unknown) => v !== null && v !== '' && v !== '0';
// PHP loose `!= ''`: '' and '0' compare equal to ''.
const notPhpEmptyString = (v: unknown) => v !== '' && v !== '0';

async function orderDetails(orderId: string) {
  return db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', orderId).execute();
}

async function orderTrackings(orderId: string) {
  return db.selectFrom('os_trackings').select('tracking').where('orderId', '=', orderId).execute();
}

// EbayApiHelper::BatchUploadeBay(). UploadShipping's result is never checked: the
// order is marked Done whenever it has items and a non-empty tracking number.
async function batchUploadEbay(): Promise<void> {
  const api = new EbayApi();
  const orders = await db.selectFrom('os_grant_order').selectAll().where('status', '=', 'submit').where('store', '=', 'E').execute();
  for (const order of orders) {
    const details = await orderDetails(order.orderId);
    // The PHP recomputes tracking per detail; the result is always the last
    // non-null row of the order's trackings.
    let tracking = '';
    for (const t of await orderTrackings(order.orderId)) if (notPhpNull(t.tracking)) tracking = t.tracking;
    const items = details.map((d) => ({ lineItemId: d.subOrderId, quantity: d.qty }));
    if (items.length > 0 && notPhpEmptyString(tracking)) {
      await api.UploadShipping(order.orderId, items, tracking);
      await db.updateTable('os_grant_order').set({ status: 'Done', updated_at: nowDb() as never }).where('id', '=', order.id).execute();
    }
  }
}

// EmailHelper::emailErrorMessage(): Mail::send of the emails.log template.
async function emailErrorMessage(subject: string, messages: string[]): Promise<void> {
  const html = `<!DOCTYPE html>\n\n\n` + messages.map((m) => `\t${m} <br/>\n\n`).join('');
  await sendMail({ from: 'admin@angelisabella.com', fromName: 'Johnny', to: 'mr.johnny.ye@gmail.com', subject, html });
}

// EbayHelper::BatchUploadRayeBay(): one CompleteSale per (detail, tracking) pair.
async function batchUploadRayeBay(): Promise<void> {
  const ebay = new Ebay('raystore');
  const orders = await db.selectFrom('os_grant_order').selectAll().where('status', '=', 'submit').where('store', '=', 'R').execute();
  const messages: string[] = [];
  for (const order of orders) {
    const trackings = await orderTrackings(order.orderId);
    for (const item of await orderDetails(order.orderId)) {
      const parts = String(item.itemId ?? '').split('-');
      for (const t of trackings) {
        if (!notPhpNull(t.tracking)) continue;
        const result = await ebay.completeSales(parts[0], parts[1], t.tracking);
        if (xmlText(result?.Ack) === 'Success') {
          await db.updateTable('os_grant_order').set({ status: 'Done', updated_at: nowDb() as never }).where('id', '=', order.id).execute();
        } else {
          messages.push(`ray ebay upload ${parts[0]} - ${parts[1] ?? ''} - ${t.tracking}`);
        }
      }
    }
  }
  if (messages.length > 0) await emailErrorMessage('Tracking Upload Error!', messages);
}

// EbayHelper::UpdateebayHandling(): fills null handling from the listing's
// DispatchTimeMax. PHP loose `== null` also matches 0/'0'.
async function updateEbayHandling(): Promise<void> {
  const ebay = new Ebay();
  const orders = await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'E').where('status', 'is', null).execute();
  for (const order of orders) {
    for (const detail of await orderDetails(order.orderId)) {
      if (detail.handling !== null && detail.handling !== 0) continue;
      const result = await ebay.getItem(detail.asin);
      if (xmlText(result?.Ack) === 'Success') {
        await db
          .updateTable('os_grant_orderdetail')
          .set({ handling: xmlText(result?.Item?.DispatchTimeMax) as never, updated_at: nowDb() as never })
          .where('id', '=', detail.id)
          .execute();
      }
    }
  }
}

export const ebayActions: Record<string, (arg1?: string) => Promise<number>> = {
  'upload-ebay-tracking': async () => { if (dryRun()) return quietDryRun('upload-ebay-tracking'); await batchUploadEbay(); return 0; },
  'upload-ray-ebay-tracking': async () => { if (dryRun()) return quietDryRun('upload-ray-ebay-tracking'); await batchUploadRayeBay(); return 0; },
  'update-ebay-handling': async () => { if (dryRun()) return quietDryRun('update-ebay-handling'); await updateEbayHandling(); return 0; },
};
