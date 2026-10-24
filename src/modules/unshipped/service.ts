// Port of UnshippedController store pages 1-5, enfloral and refreshNotes
// (routes/web.php:141-147, role:admin,user,remote). Shared private helpers
// (GenerateQuickSearch, staffs, buyer/item stats, ProductMap attach) are
// ported once here and reused by every store page, as in the PHP.
//
// UpdateEtsyOrders() is NOT ported: its only caller is the commented-out
// `// $this->UpdateEtsyOrders();` at UnshippedController.php:439 — dead code
// on these routes. Debugbar::info calls dropped.

import { Kysely } from 'kysely';
import { db } from '../../db.js';
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
  let t = /\d{4}-\d{1,2}-\d{1,2}/.test(String(base ?? '')) ? strtotime(String(base)) : 0;
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
export function multiOrdersHtml(orderIds: string[], suffix: string): string {
  if (orderIds.length <= 1) return '';
  let html = '<br> Multi-orders ';
  for (const b of orderIds) html += `<br><a href='#${shortId(b)}'>${shortId(b)}</a>${suffix}`;
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
    const ids = detail.map(() => o.orderId as string);
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(ids, '<br>'),
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
      multiOrdersHtml: multiOrdersHtml(addrStats[String(o.address1 ?? '') + String(o.zip ?? '')] ?? [], '<br/>'),
      mobileMultiOrdersHtml: multiOrdersHtml(addrStats[String(o.address1 ?? '') + String(o.zip ?? '')] ?? [], ''),
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
    const ids = detail.map(() => o.orderId as string);
    return {
      ...o,
      detail,
      buyerKey: key,
      multiOrdersHtml: multiOrdersHtml(ids, '<br>'),
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
