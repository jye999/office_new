// Port of UnshippedController store pages 1-5, enfloral and refreshNotes
// (routes/web.php:141-147, role:admin,user,remote). Shared private helpers
// (GenerateQuickSearch, staffs, buyer/item stats, ProductMap attach) are
// ported once here and reused by every store page, as in the PHP.
//
// UpdateEtsyOrders() is NOT ported: its only caller is the commented-out
// `// $this->UpdateEtsyOrders();` at UnshippedController.php:439 — dead code
// on these routes. Debugbar::info calls dropped.

import { Kysely } from 'kysely';
import { db, hwc } from '../../db.js';
import { date, strtotime } from '../../view.js';

export type Row = Record<string, unknown>;

// os_mades / os_priority are not in the generated DB map (same cast as routes.ts).
// SAFETY: both tables exist in the office schema; only the typed map omits them.
const raw = db as unknown as Kysely<{ os_mades: any; os_priority: any }>;

// ------------------------------------------------------------------ shared

// GenerateQuickSearch(): Setting::where('name','=','QuickSearch')->first().
// Emits the raw JS string the layout injects with {!! !!}.
export async function generateQuickSearch(): Promise<string> {
  const quickSearch = await db.selectFrom('os_settings').select('value').where('name', '=', 'QuickSearch').executeTakeFirst();
  let content = '';
  if (quickSearch != null) {
    const parts = String(quickSearch.value ?? '').split('|');
    let script = '';
    for (let i = 0; i < parts.length; i++) {
      parts[i] = parts[i].trim();
      const btnName = parts[i].replace(/ /g, '') + 'Btn';
      content += `<button id='${btnName}' class='pull-left hidden-xs'>${parts[i]}</button>`;
      script +=
        `\n                    \$(document).on('click','#${btnName}',function(e){\n` +
        `        e.preventDefault();\n` +
        `        var searchText ='${parts[i]}';\n` +
        `        \$('#orders_filter label input').val(searchText);\n` +
        `         oTable.search(searchText).draw();\n` +
        `    });\n`;
    }
    content = `\$('.quickSearch').html("${content}");` + script;
  }
  return content;
}

// Staff::where('status','=','Active')->where('company_id',...)->orderBy('name')->get().
export async function activeStaffs(companyId: unknown): Promise<Row[]> {
  return db
    .selectFrom('os_staffs')
    .selectAll()
    .where('status', '=', 'Active')
    .where('company_id', '=', String(companyId) as never)
    .orderBy('name')
    .execute();
}

// GrantOrder::with('detail')->where('store','=','X')->whereNull('status')->get().
// hasMany, no ORDER BY (insertion order, like Eloquent).
export async function grantOrdersWithDetail(store: string): Promise<(Row & { detail: Row[] })[]> {
  const orders = await db.selectFrom('os_grant_order').selectAll().where('store', '=', store).where('status', 'is', null).execute();
  const orderIds = orders.map((o) => o.orderId);
  const details = orderIds.length ? await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', orderIds).execute() : [];
  return orders.map((o) => ({ ...o, detail: details.filter((d) => d.orderId === o.orderId) }));
}

// buyerStats/itemStats accumulation. PHP string-concat keys: null -> ''.
export function buildStats(
  orders: (Row & { detail: Row[] })[],
  buyerKeyOf: (o: Row) => unknown,
  itemKeyOf: (i: Row) => unknown,
): { buyerStats: Record<string, string[]>; itemStats: Record<string, number> } {
  const buyerStats: Record<string, string[]> = {};
  const itemStats: Record<string, number> = {};
  for (const o of orders) {
    for (const i of o.detail) {
      const bk = String(buyerKeyOf(o) ?? '');
      if (bk in buyerStats) buyerStats[bk].push(o.orderId as string);
      else buyerStats[bk] = [o.orderId as string];
      const ik = String(itemKeyOf(i) ?? '');
      if (ik in itemStats) itemStats[ik] += i.qty as number;
      else itemStats[ik] = i.qty as number;
    }
  }
  return { buyerStats, itemStats };
}

// ------------------------------------------------------------------ ProductMap

// GrantOrderDetail::ProductMap(): hasOne ProductMap where externalId=sku AND
// store=detail.store; when that query has <1 row, fall back to externalId=asin.
// ->Product -> locations attached (ProductMap::Product hasOne Product
// sku=sku; Product::locations hasMany, no ORDER BY).
export async function attachProductMaps(details: Row[]): Promise<void> {
  for (const d of details) {
    let map: Row | null = null;
    if (d.sku != null) {
      map =
        (await db.selectFrom('os_product_map').selectAll().where('externalId', '=', String(d.sku)).where('store', '=', String(d.store)).executeTakeFirst()) ??
        null;
    }
    if (map == null && d.asin != null) {
      map =
        (await db.selectFrom('os_product_map').selectAll().where('externalId', '=', String(d.asin)).where('store', '=', String(d.store)).executeTakeFirst()) ??
        null;
    }
    d['ProductMap'] = map;
    if (map == null) d['skuLocationHtml'] = '';
    if (map != null) {
      const product =
        map.sku != null ? ((await db.selectFrom('os_products').selectAll().where('sku', '=', String(map.sku)).executeTakeFirst()) ?? null) : null;
      map['Product'] = product;
      if (product != null) {
        map['locations'] = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', String(product.id) as never).execute();
      }
    }
    // The views echo $l->location."-".$l->qty."<br/>" in a raw-PHP block.
    const locs = (map?.['locations'] as Row[]) ?? [];
    d['skuLocationHtml'] = locs.map((l) => `${l.location ?? ''}-${l.qty ?? ''}<br/>`).join('');
  }
}

// ------------------------------------------------------------------ PHP quirks

// PHP loose == against the small targets used in these views.
export function looseEq(value: unknown, target: 1 | 2 | true): boolean {
  if (value == null) return false;
  if (target === true) return String(value) !== '' && String(value) !== '0';
  return String(value).trim() !== '' && Number(value) === target;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const daysPast = (t: number) => Math.ceil((nowSec() - t) / 60 / 60 / 24);

// strtotime('YYYY-MM-DD ... +N days|weekdays'): date + the relative suffix.
// Unparseable base -> epoch 0, like PHP strtotime() === false.
function strtotimeRel(base: unknown, rel: string): number {
  const m = /([+-])\s*(\d+)\s*(days|weekdays)/.exec(rel);
  let t = /\d{4}-\d{1,2}-\d{1,2}/.test(String(base ?? '')) ? strtotime(String(base)) : Math.floor(Date.now() / 1000);
  if (!m) return t;
  const n = Number(m[2]);
  const sign = m[1] === '-' ? -1 : 1;
  for (let k = 0; k < n; k++) {
    t += sign * 86400;
    if (m[3] === 'weekdays') {
      // PHP advances day-by-day skipping Sat/Sun.
      const dow = new Date(t * 1000).getUTCDay();
      if (dow === 6) t += (sign === -1 ? -1 : 2) * 86400;
      else if (dow === 0) t += (sign === -1 ? 2 : -1) * 86400;
    }
  }
  return t;
}

const days = (base: unknown, n: number) => strtotimeRel(base, ` + ${n} days`);
const minusDays = (base: unknown, n: number) => strtotimeRel(base, ` - ${n} days`);
const weekdays = (base: unknown, n: number) => strtotimeRel(base, ` + ${n} weekdays`);
const ymd = (t: number) => date('Y-m-d', t);

// substr($s, -7)
export const shortId = (s: unknown) => String(s ?? '').slice(-7);

// `<br> Multi-orders` block echoed by raw PHP in the views; suffix is '<br/>'
// in the desktop loop, '' in the mobile loop.
export function multiOrdersHtml(orderIds: string[], suffix: string, short = true): string {
  if (orderIds.length <= 1) return '';
  let html = '<br> Multi-orders ';
  for (const b of orderIds) html += `<br><a href='#${short ? shortId(b) : b}'>${short ? shortId(b) : b}</a>${suffix}`;
  return html;
}

// prioritizeBtn switch($order['priority']).
export function prioritizeText(priority: unknown): string {
  if (looseEq(priority, 1)) return 'Urgent';
  if (looseEq(priority, 2)) return 'UnPrioritize';
  return 'Prioritize';
}

// ------------------------------------------------------------------ per-view prep

// Fields the views used to compute in <?php ?> blocks, now computed in the
// handler (CONVENTIONS: compute PHP in the TS handler and pass it in).
export type PrepOrder = Row & {
  detail: (Row & Record<string, unknown>)[];
  buyerKey: string;
  multiOrdersHtml: string; // '' when <=1 order for the buyer key
  multiOrderCount: number;
  prioritizeBtnText: string;
  urgentFlag: boolean;
  firstOrdersCell?: string; // store5/enfloral: implode(',', array_unique(bucket))
  addressBuyerKey?: string; // store2: address1.zip key for the view's lookups
};

// store1 (eBay, store 'E').
export async function prepareStore1(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('E');
  const { buyerStats, itemStats } = buildStats(raw, (o) => o.email, (i) => 'a' + String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.email ?? '');
    const detail = o.detail.map((i) => {
      // Per-item $priorityFlag block (evaluated inside the detail foreach).
      let flag = looseEq(o.priority, true) ? 'priority' : '';
      if (flag === '') {
        if (o.planShipDate != null) {
          if (daysPast(strtotime(String(o.planShipDate))) > -1) flag = 'priority';
        } else if (i.handling != null) {
          if (daysPast(days(o.paymentDate, (i.handling == null ? 0 : Number(i.handling)) + 3)) > -1) flag = 'priority';
        }
      }
      return {
        ...i,
        priorityFlag: flag,
        itemID0: String(i.itemId ?? '').split('-')[0] ?? '',
        variationValue: String(i.variation ?? '').split('|')[1] ?? '',
        shipDate: ymd(days(o.paymentDate, (i.handling == null ? 0 : Number(i.handling)))),
        notesFromBuyerHtml: String(o.notesFromBuyer ?? '').length > 1 ? `<br/>Notes From Buyer : ${o.notesFromBuyer}` : '',
        selfNotesHtml: String(o.selfNotes ?? '').length > 1 ? `<br/>Notes To Seller : ${o.selfNotes}` : '',
      };
    });
    const ids = buyerStats[key] ?? [];
    // store4 echoes the full order id (no shortId) and a '<br>' after each link.
    const multi = ids.length > 1 ? `<br> Multi-orders ${ids.map((b) => `<br><a href='#${b}'>${b}</a><br>`).join('')}` : '';
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multi,
      multiOrderCount: ids.length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// store2 (Amazon, store 'A'). The view looks up buyerStats under BOTH the
// email key and the address1.zip key — the PHP array carries both.
export async function prepareStore2(user: { company_id?: number } | null, showDesktop: boolean): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
  showDesktop: boolean;
}> {
  const raw = await grantOrdersWithDetail('A');
  for (const o of raw) await attachProductMaps(o.detail);
  const { buyerStats: addrStats } = buildStats(raw, (o) => String(o.address1 ?? '') + String(o.zip ?? ''), (i) => i.asin);
  const { buyerStats: emailStats, itemStats } = buildStats(raw, (o) => o.email, (i) => i.asin);
  const orders = raw.map((o) => {
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag:
        String(i.isPrime ?? '') === 'true' ||
        looseEq(o.priority, 1) ||
        daysPast(strtotime(String(i.promiseDate ?? ''))) >= -1
          ? 'priority'
          : '',
      multiOrdersHtml: multiOrdersHtml(addrStats[String(o.address1 ?? '') + String(o.zip ?? '')] ?? [], '<br>', false),
      mobileMultiOrdersHtml: multiOrdersHtml(addrStats[String(o.address1 ?? '') + String(o.zip ?? '')] ?? [], '', false),
      shipDate: ymd(minusDays(i.promiseDate, 2)),
      notesFromBuyerHtml: '',
      selfNotesHtml: '',
    }));
    const emailKey = String(o.email ?? '');
    return {
      ...o,
      detail,
      buyerKey: emailKey,
      addressBuyerKey: String(o.address1 ?? '') + String(o.zip ?? ''),
      multiOrdersHtml: multiOrdersHtml(emailStats[emailKey] ?? [], '<br>'),
      multiOrderCount: (emailStats[emailKey] ?? []).length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats: { ...emailStats, ...addrStats }, itemStats, staffs, quickSearchContent: await generateQuickSearch(), showDesktop };
}

// store4 (Etsy, store 'T').
export async function prepareStore4(user: { company_id?: number } | null, showDesktop: boolean): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
  showDesktop: boolean;
}> {
  const raw = await grantOrdersWithDetail('T');
  for (const o of raw) await attachProductMaps(o.detail);
  const { buyerStats, itemStats } = buildStats(raw, (o) => o.buyer, (i) => i.asin);
  const orders = raw.map((o) => {
    const key = String(o.buyer ?? '');
    const detail = o.detail.map((i) => {
      const flag =
        looseEq(o.priority, true) ||
        daysPast(weekdays(o.purchaseDate, (i.handling == null ? 0 : Number(i.handling)) - 1)) >= 0
          ? 'priority'
          : '';
      return {
        ...i,
        priorityFlag: flag,
        shipDate: ymd(weekdays(i.promiseDate, 0)),
        notesFromBuyerHtml: '',
        selfNotesHtml: '',
      };
    });
    const ids = buyerStats[key] ?? [];
    // store4 echoes the full order id (no shortId) and a '<br>' after each link.
    const multi = ids.length > 1 ? `<br> Multi-orders ${ids.map((b) => `<br><a href='#${b}'>${b}</a><br>`).join('')}` : '';
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multi,
      multiOrderCount: ids.length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch(), showDesktop };
}

// store5 (Shopify, store 'S') and enfloral (store 'EF') — identical PHP.
export async function prepareStore5(user: { company_id?: number } | null, store: 'S' | 'EF'): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail(store);
  const { buyerStats, itemStats } = buildStats(raw, (o) => String(o.recipientName ?? '') + String(o.email ?? ''), (i) => 'a' + String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.recipientName ?? '') + String(o.email ?? '');
    const detail = o.detail.map((i) => {
      let flag = looseEq(o.priority, true) ? 'priority' : '';
      if (flag === '') {
        if (o.planShipDate != null) {
          if (daysPast(strtotime(String(o.planShipDate))) > -1) flag = 'priority';
        } else if (i.handling != null) {
          if (daysPast(days(o.paymentDate, i.handling == null ? 0 : Number(i.handling))) > -1) flag = 'priority';
        }
      }
      return {
        ...i,
        priorityFlag: flag,
        itemID0: String(i.itemId ?? '').split('-')[1] ?? '', // desclink uses itemID[1] here
        itemIDFirst: String(i.itemId ?? '').split('-')[0] ?? '',
        variationValue: String(i.variation ?? '').split('|')[1] ?? '',
        shipDate: ymd(strtotime(String(o.purchaseDate ?? ''))),
        notesFromBuyerHtml: String(o.notesFromBuyer ?? '').length > 1 ? `<br/>Notes From Buyer : ${o.notesFromBuyer}` : '',
        selfNotesHtml: String(o.selfNotes ?? '').length > 1 ? `<br/>Notes To Seller : ${o.selfNotes}` : '',
      };
    });
    const ids = detail.map(() => o.orderId as string);
    return {
      ...o,
      detail,
      buyerKey: key,
      firstOrdersCell: [...new Set(buyerStats[key] ?? [])].join(','),
      multiOrdersHtml: multiOrdersHtml(ids, '<br>'),
      multiOrderCount: ids.length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// ------------------------------------------------------------------ stores 6-13

// 6/7/8: priority==true, or planShipDate past due, or paymentDate+(handling+3) days past due.
function flagPayment(o: Row, i: Row): string {
  let flag = looseEq(o.priority, true) ? 'priority' : '';
  if (flag === '' && o.planShipDate != null) {
    if (daysPast(strtotime(String(o.planShipDate))) > -1) flag = 'priority';
  } else if (flag === '' && i.handling != null) {
    if (daysPast(days(o.paymentDate, (i.handling == null ? 0 : Number(i.handling)) + 3)) > -1) flag = 'priority';
  }
  return flag;
}

// 9/10: same shape but the fallback uses planShipDate+(handling+1) days (PHP quirk).
function flagPlan(o: Row, i: Row): string {
  let flag = looseEq(o.priority, true) ? 'priority' : '';
  if (flag === '' && o.planShipDate != null) {
    if (daysPast(strtotime(String(o.planShipDate))) > -1) flag = 'priority';
  } else if (flag === '' && i.handling != null) {
    if (daysPast(days(o.planShipDate, (i.handling == null ? 0 : Number(i.handling)) + 1)) > -1) flag = 'priority';
  }
  return flag;
}

// 11/12/13: priority==true, or purchaseDate+(handling-1) weekdays already passed.
function flagWeekdays(o: Row, i: Row): string {
  return looseEq(o.priority, true) || daysPast(weekdays(o.purchaseDate, (i.handling == null ? 0 : Number(i.handling)) - 1)) >= 0 ? 'priority' : '';
}

// store9/10 merge: fold each detail row into the previous row when itemId,
// variation and name all match (consecutive scan, like the PHP for loop).
function mergeConsecutiveDetail(details: Row[]): Row[] {
  for (let oi = 1; oi < details.length; oi++) {
    const item = details[oi];
    const prev = details[oi - 1];
    if (item.itemId == prev.itemId && item.variation == prev.variation && item.name == prev.name) {
      item.qty = (item.qty as number) + (prev.qty as number);
      details.splice(oi - 1, 1);
      oi--;
    }
  }
  return details;
}

// 12/13: (int)handling, <3 -> 2, else handling-2; non-numeric handling -> 0.
function handlingAdjusted(h: unknown): number {
  if (h == null) return 0;
  const s = String(h).trim();
  if (s === '' || isNaN(Number(s))) return 0;
  const x = Math.trunc(Number(s));
  return x < 3 ? 2 : x - 2;
}

// notesFromBuyer/selfNotes spans shared by the eBay-flavoured views.
function notesHtml(o: Row): { notesFromBuyerHtml: string; selfNotesHtml: string } {
  return {
    notesFromBuyerHtml: String(o.notesFromBuyer ?? '').length > 1 ? `<br/>Notes From Buyer : ${o.notesFromBuyer}` : '',
    selfNotesHtml: String(o.selfNotes ?? '').length > 1 ? `<br/>Notes To Seller : ${o.selfNotes}` : '',
  };
}

// store6 (eBay, store 'R').
export async function prepareStore6(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('R');
  const { buyerStats, itemStats } = buildStats(raw, (o) => o.email, (i) => 'a' + String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.email ?? '');
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag: flagPayment(o, i),
      itemID0: String(i.itemId ?? '').split('-')[0] ?? '',
      variationValue: String(i.variation ?? '').split('|')[1] ?? '',
      shipDate: ymd(days(o.paymentDate, (i.handling == null ? 0 : Number(i.handling)) + 3)),
      ...notesHtml(o),
    }));
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(buyerStats[key] ?? [], '<br>'),
      multiOrderCount: (buyerStats[key] ?? []).length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// store7 (store 'O'). Multi-orders links use the FULL order id (no shortId).
// Prioritize button: 'UnPrioritize' only when priority == 1.
export async function prepareStore7(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('O');
  // Old store7 keys itemStats by plain asin while the view looks up 'a'.asin (so the count is blank).
  const { buyerStats, itemStats } = buildStats(raw, (o) => String(o.recipientName ?? '').replace(/ /g, '_'), (i) => String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.recipientName ?? '').replace(/ /g, '_');
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag: flagPayment(o, i),
      shipDate: ymd(days(o.paymentDate, (i.handling == null ? 0 : Number(i.handling)) + 3)),
      ...notesHtml(o),
    }));
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(buyerStats[key] ?? [], '<br>', false),
      multiOrderCount: (buyerStats[key] ?? []).length,
      prioritizeBtnText: looseEq(o.priority, 1) ? 'UnPrioritize' : 'Prioritize',
      urgentFlag: false,
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// store8 (Houzz, store 'H') — same shape as store6.
export async function prepareStore8(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('H');
  const { buyerStats, itemStats } = buildStats(raw, (o) => o.email, (i) => 'a' + String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.email ?? '');
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag: flagPayment(o, i),
      itemID0: String(i.itemId ?? '').split('-')[0] ?? '',
      variationValue: String(i.variation ?? '').split('|')[1] ?? '',
      shipDate: ymd(days(o.paymentDate, (i.handling == null ? 0 : Number(i.handling)) + 3)),
      ...notesHtml(o),
    }));
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(buyerStats[key] ?? [], '<br>'),
      multiOrderCount: (buyerStats[key] ?? []).length,
      prioritizeBtnText: looseEq(o.priority, 1) ? 'UnPrioritize' : 'Prioritize',
      urgentFlag: false,
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// store9 (Walmart, store 'W'): consecutive detail merge + ProductMap attach.
export async function prepareStore9(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('W');
  for (const o of raw) {
    mergeConsecutiveDetail(o.detail);
    await attachProductMaps(o.detail);
  }
  const { buyerStats, itemStats } = buildStats(raw, (o) => o.email, (i) => 'a' + String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.email ?? '');
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag: flagPlan(o, i),
      itemID0: String(i.itemId ?? '').split('-')[0] ?? '',
      variationValue: String(i.variation ?? '').split('|')[1] ?? '',
      shipDate: ymd(strtotime(String(o.planShipDate ?? ''))),
      ...notesHtml(o),
    }));
    return {
      ...o,
      detail,
      buyerKey: key,
      // 'shippingCost' is DECIMAL (string); PHP compares numerically.
      shippingCostPositive: Number(o.shippingCost ?? 0) > 0,
      multiOrdersHtml: multiOrdersHtml(buyerStats[key] ?? [], '<br>'),
      multiOrderCount: (buyerStats[key] ?? []).length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// store10 (Etsy-D, store 'D'): same merge + flag shape as store9, no ProductMap.
export async function prepareStore10(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('D');
  for (const o of raw) mergeConsecutiveDetail(o.detail);
  const { buyerStats, itemStats } = buildStats(raw, (o) => o.email, (i) => 'a' + String(i.asin ?? ''));
  const orders = raw.map((o) => {
    const key = String(o.email ?? '');
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag: flagPlan(o, i),
      itemID0: String(i.itemId ?? '').split('-')[0] ?? '',
      variationValue: String(i.variation ?? '').split('|')[1] ?? '',
      shipDate: ymd(strtotime(String(o.planShipDate ?? ''))),
      ...notesHtml(o),
    }));
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(buyerStats[key] ?? [], '<br>'),
      multiOrderCount: (buyerStats[key] ?? []).length,
      prioritizeBtnText: looseEq(o.priority, 1) ? 'UnPrioritize' : 'Prioritize',
      urgentFlag: false,
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: await generateQuickSearch() };
}

// 11/12/13 share the Etsy-shape stats/flags (buyer key, asin item key, full-id
// multi-orders); only the per-item shipDate differs per view.
function prepareEtsy(orders: (Row & { detail: Row[] })[]): {
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
} {
  const { buyerStats, itemStats } = buildStats(orders, (o) => o.buyer, (i) => i.asin);
  const out = orders.map((o) => {
    const key = String(o.buyer ?? '');
    const detail = o.detail.map((i) => ({
      ...i,
      priorityFlag: flagWeekdays(o, i),
    }));
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(buyerStats[key] ?? [], '<br>', false),
      multiOrderCount: (buyerStats[key] ?? []).length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  return { orders: out, buyerStats, itemStats };
}

type StorePrep = {
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
};

async function finishPrep(user: { company_id?: number } | null, base: Omit<StorePrep, 'staffs' | 'quickSearchContent'>): Promise<StorePrep> {
  return { ...base, staffs: await activeStaffs(user?.company_id), quickSearchContent: await generateQuickSearch() };
}

// store11 (Etsy 2, store 'T2'). The view's shipDate is promiseDate; the
// handling-adjusted date only exists in a commented-out block.
export async function prepareStore11(user: { company_id?: number } | null): Promise<StorePrep> {
  const raw = await grantOrdersWithDetail('T2');
  for (const o of raw) await attachProductMaps(o.detail);
  const base = prepareEtsy(raw);
  const orders = base.orders.map((o) => ({
    ...o,
    detail: o.detail.map((i) => ({ ...i, shipDate: ymd(strtotime(String(i.promiseDate ?? ''))) })),
  }));
  return finishPrep(user, { ...base, orders });
}

// store12 (Etsy 3, store 'T3'). shipDate uses the handling-adjusted weekdays.
export async function prepareStore12(user: { company_id?: number } | null): Promise<StorePrep> {
  const raw = await grantOrdersWithDetail('T3');
  for (const o of raw) await attachProductMaps(o.detail);
  const base = prepareEtsy(raw);
  const orders = base.orders.map((o) => ({
    ...o,
    detail: o.detail.map((i) => ({ ...i, shipDate: ymd(weekdays(o.purchaseDate, handlingAdjusted(i.handling))) })),
  }));
  return finishPrep(user, { ...base, orders });
}

// GrantOrderDetail::Product (hasOne Product sku=sku) with locations + images
// attached (Product::locations/images hasMany, no ORDER BY).
export async function attachProduct(details: Row[]): Promise<void> {
  for (const d of details) {
    const product =
      d.sku != null ? ((await db.selectFrom('os_products').selectAll().where('sku', '=', String(d.sku)).executeTakeFirst()) ?? null) : null;
    d['Product'] = product;
    if (product != null) {
      const locs = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', String(product.id) as never).execute();
      d['productLocationsHtml'] = locs.map((l) => `${l.location ?? ''}-${l.qty ?? ''}<br/>`).join('');
      const images = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(product.id) as never).execute();
      d['productImage'] = images.length > 0 ? (images[0]['filename'] ?? '') : '';
    } else {
      d['productLocationsHtml'] = '';
      d['productImage'] = '';
    }
  }
}

// store13 (Wayfair, store 'WF').
export async function prepareStore13(user: { company_id?: number } | null): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail('WF');
  for (const o of raw) await attachProduct(o.detail);
  const base = prepareEtsy(raw);
  const orders = base.orders.map((o) => ({
    ...o,
    detail: o.detail.map((i) => ({ ...i, shipDate: ymd(weekdays(o.purchaseDate, handlingAdjusted(i.handling))) })),
  }));
  return finishPrep(user, { ...base, orders });
}

// store3: file_get_contents (external angelisabella feed) — behind a seam so
// tests never call the live site.
type FetchFn = (url: string) => Promise<string | false>;
const liveFetch: FetchFn = async (url) => {
  try {
    const res = await fetch(url);
    return res.status === 200 ? await res.text() : false;
  } catch {
    return false;
  }
};
let fetchImpl: FetchFn = liveFetch;
export function setUnshipped3FetcherForTests(fn: FetchFn | null): void {
  fetchImpl = fn ?? liveFetch;
}

export async function prepareStore3(user: { company_id?: number } | null): Promise<{
  orderItems: Row[];
  buyers: Record<string, { order: string[] }>;
  staffs: Row[];
}> {
  const result = await fetchImpl('http://store.angelisabella.com/index.php?route=feed/rest_api/unshipped&key=averyverylongsecret');
  // json_decode($result, true) — null when $result === false / bad JSON.
  let ordersResponse: Row | null = null;
  if (result !== false) {
    try {
      ordersResponse = JSON.parse(result) as Row;
    } catch {
      ordersResponse = null;
    }
  }
  const orderItems: Row[] = [];
  const buyers: Record<string, { order: string[] }> = {};
  if (ordersResponse != null && (ordersResponse['success'] as number) > 0) {
    const items: Row[] = (ordersResponse['orderitems'] as Row[]) ?? [];
    for (const item of items) {
      const k = String(item['customer'] ?? '');
      if (k in buyers) buyers[k]['order'].push(item['order_id'] as string);
      else buyers[k] = { order: [item['order_id'] as string] };
    }
    for (let i = 0; i < items.length; i++) {
      const made = await raw.selectFrom('os_mades').selectAll().where('orderId', '=', String(items[i]['order_id'] ?? '')).executeTakeFirst();
      items[i]['made'] = made != null;
      const priority = await raw.selectFrom('os_priority').selectAll().where('orderId', '=', String(items[i]['order_id'] ?? '')).executeTakeFirst();
      items[i]['priority'] = 0;
      items[i]['notes'] = '';
      if (priority != null) {
        if (looseEq(priority.highpriority, 1)) items[i]['priority'] = 1;
        if (priority.notes) items[i]['notes'] = priority.notes;
      }
      orderItems[i] = items[i];
    }
  }
  const staffs = await activeStaffs(user?.company_id);
  return { orderItems, buyers, staffs };
}

// ------------------------------------------------------------------ U3: stores 90/91/92/101

// Shared shape of store90/91/92/101: buyerStats gets the order id under BOTH the
// address1+zip and the email key (once per detail row); itemStats is keyed by sku.
type GrantKind = 'hwc2' | 'hwc8' | 'plain' | 'temu';

async function prepareGrantStore(
  user: { company_id?: number } | null,
  store: string,
  kind: GrantKind,
): Promise<{
  orders: PrepOrder[];
  buyerStats: Record<string, string[]>;
  itemStats: Record<string, number>;
  staffs: Row[];
  quickSearchContent: string;
}> {
  const raw = await grantOrdersWithDetail(store);
  const buyerStats: Record<string, string[]> = {};
  const itemStats: Record<string, number> = {};
  const hwcFnskus: Record<string, string> = {};
  const hwcCompany = kind === 'hwc2' ? '2' : kind === 'hwc8' ? '8' : null;
  for (const o of raw) {
    await attachProductMaps(o.detail);
    for (const i of o.detail) {
      const sku = i.sku as string | null;
      if (hwcCompany != null && sku != null && sku !== '') {
        // HwcProduct::where('company_id', C)->where(sku|upc|fnsku = $asin)->get(); the view print_r's each fnsku.
        // SAFETY: hwc.products is missing from the generated hwc type map (and from this dev DB), so cast.
        const rows = await (hwc as unknown as Kysely<{ products: Record<string, any> }>)
          .selectFrom('products')
          .select('fnsku')
          .where('company_id', '=', hwcCompany)
          .where((eb) => eb.or([eb('sku', '=', sku), eb('upc', '=', sku), eb('fnsku', '=', sku)]))
          .execute();
        hwcFnskus[sku] = rows.map((r: Record<string, unknown>) => String(r.fnsku ?? '')).join('');
      }
      if (kind === 'temu') {
        const product = await db.selectFrom('os_products').select('id').where('sku', '=', String(sku ?? '')).executeTakeFirst();
        if (product != null) {
          const img = await db.selectFrom('os_product_images').select('filename').where('product_id', '=', String(product.id) as never).executeTakeFirst();
          if (img != null) i['image'] = '/storage/product_images_full/' + img.filename;
        }
      }
      const addrKey = String(o.address1 ?? '') + String(o.zip ?? '');
      const emailKey = String(o.email ?? '');
      (buyerStats[addrKey] ??= []).push(o.orderId as string);
      (buyerStats[emailKey] ??= []).push(o.orderId as string);
      const ik = String(sku ?? '');
      itemStats[ik] = ik in itemStats ? itemStats[ik] + (i.qty as number) : (i.qty as number);
    }
  }
  const orders = raw.map((o) => {
    const addrKey = String(o.address1 ?? '') + String(o.zip ?? '');
    const ids = buyerStats[addrKey] ?? [];
    const detail = o.detail.map((i) => {
      const sku = String(i.sku ?? '');
      // 90/92 view: `$hwc[$item->sku]` on an unset key is a PHP "Undefined index" -> 500.
      if (hwcCompany != null && !(sku in hwcFnskus)) throw new Error(`Undefined index: ${sku}`);
      return {
        ...i,
        priorityFlag:
          String(i.isPrime ?? '') === 'true' || looseEq(o.priority, 1) || daysPast(strtotime(String(i.promiseDate ?? ''))) >= -1 ? 'priority' : '',
        shipDate: ymd(minusDays(i.promiseDate, 2)),
        hwcFnskus: hwcFnskus[sku] ?? '',
        // 90/101 blank the count for an empty sku; 91 prints $itemStats[$sku] unconditionally.
        sameCount: kind === 'plain' || sku !== '' ? itemStats[sku] : '',
      };
    });
    return {
      ...o,
      detail,
      buyerKey: addrKey,
      addrKey,
      // address1.' '.address2.', '.state.' '.zip (PHP concat renders null as '')
      addressLine: [o.address1, ' ', o.address2, ', ', o.state, ' ', o.zip].map((x) => (x == null ? '' : String(x))).join(''),
      emailKey: String(o.email ?? ''),
      multiOrdersHtml: ids.length > 1 ? `<br> Multi-orders ${ids.map((b) => `<br><a href='#${b}'>${b}</a><br>`).join('')}` : '',
      multiOrderCount: ids.length,
      prioritizeBtnText: prioritizeText(o.priority),
      urgentFlag: looseEq(o.priority, 2),
    };
  });
  const staffs = await activeStaffs(user?.company_id);
  return { orders, buyerStats, itemStats, staffs, quickSearchContent: '' };
}

export const prepareStore90 = (u: { company_id?: number } | null) => prepareGrantStore(u, 'WINDY', 'hwc2');
export const prepareStore92 = (u: { company_id?: number } | null) => prepareGrantStore(u, 'mermaid', 'hwc8');
export const prepareStore91 = (u: { company_id?: number } | null) => prepareGrantStore(u, 'FOUR', 'plain');
export const prepareStore101 = (u: { company_id?: number } | null) => prepareGrantStore(u, 'TEMU', 'temu');

// ------------------------------------------------------------------ U3: Faire

// PHP strtotime() on the ISO-8601 ('2025-08-04T12:00:00.000Z') strings Faire stores; false -> 0.
const isoTs = (s: unknown): number => {
  const t = Date.parse(String(s ?? ''));
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
};

// fairestore(): FaireOrder (content cast to object) in PROCESSING/NEW, plus the
// bin locations of every sku (Product::with('locations')->where('sku')->first()).
export async function prepareFaire(): Promise<{ orders: Row[]; quickSearchContent: string }> {
  const rows = await db.selectFrom('os_faire_orders').selectAll().where('order_status', 'in', ['PROCESSING', 'NEW']).execute();
  const locations: Record<string, string> = {};
  const orders: Row[] = [];
  for (const o of rows) {
    const content = (typeof o.content === 'string' ? JSON.parse(o.content) : o.content) as Row;
    const items = (content['items'] as Row[]) ?? [];
    for (const item of items) {
      const sku = item['sku'];
      if (sku != null && !(String(sku) in locations)) {
        const product = await db.selectFrom('os_products').select('id').where('sku', '=', String(sku)).executeTakeFirst();
        if (product != null) {
          const locs = await db.selectFrom('os_product_locations').select('location').where('product_id', '=', String(product.id) as never).execute();
          locations[String(sku)] = locs.map((l) => `${l.location ?? ''} , `).join('');
        }
      }
    }
    const ship = content['expected_ship_date'];
    orders.push({
      display_id: o.display_id,
      companyName: ((content['address'] as Row) ?? {})['company_name'],
      shipDateHtml: ship != null ? `<br/>Ship Date: ${date('Y-m-d', isoTs(ship))}` : '',
      items: items.map((item) => ({
        sku: item['sku'] ?? '',
        quantity: item['quantity'] ?? '',
        product_name: item['product_name'],
        variant_name: item['variant_name'] ?? '',
        locationHtml: item['sku'] != null ? (locations[String(item['sku'])] ?? '') : '',
      })),
      createdDate: date('Y-m-d', isoTs(content['created_at'])),
      expectedShip: ship != null ? date('Y-m-d', isoTs(ship)) : 'Not set yet',
    });
  }
  return { orders, quickSearchContent: '' };
}
