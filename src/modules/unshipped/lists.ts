// UnshippedController list pages (routes/web.php:113-121, 148, 326, role:admin,user,remote):
// allunshipped, PackingList, PendingShipment, processed, summary, searchOrder, createPacking, geturls.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db } from '../../db.js';
import { input } from '../../http.js';
import { currentUser } from '../../auth.js';
import { route, any } from '../../router.js';
import { render, sendServer500 } from '../../view.js';
import { activeStaffs, attachProductMaps, generateQuickSearch, mergeConsecutiveDetail, type Row } from './service.js';

const ROLES = ['admin', 'user', 'remote'];
type User = { company_id?: number } | null;
type Order = Row & { detail: Row[] };

// Both stats keys are pushed once per detail row (PHP isset/array_push).
function pushBuyer(buyerStats: Record<string, string[]>, o: Row): void {
  (buyerStats[String(o.address1 ?? '') + String(o.zip ?? '')] ??= []).push(o.orderId as string);
  (buyerStats[String(o.email ?? '')] ??= []).push(o.orderId as string);
}

async function ordersWhere(where: (q: any) => any): Promise<Order[]> {
  const orders = await where(db.selectFrom('os_grant_order').selectAll()).execute();
  const ids = orders.map((o: Row) => o.orderId);
  const details = ids.length ? await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', ids).execute() : [];
  return orders.map((o: Row) => ({ ...o, detail: details.filter((d) => d.orderId === o.orderId) }));
}

// allunshipped(): every unshipped order except store WINDY.
export async function prepareAllUnshipped(user: User) {
  const orders = await ordersWhere((q) => q.where('status', 'is', null).where('store', 'not in', ['WINDY']));
  const buyerStats: Record<string, string[]> = {};
  const itemStats: Record<string, number> = {};
  for (const o of orders) {
    await attachProductMaps(o.detail);
    for (const i of o.detail) {
      pushBuyer(buyerStats, o);
      const k = String(i.asin ?? '') + String(i.sku ?? '');
      itemStats[k] = k in itemStats ? itemStats[k] + (i.qty as number) : (i.qty as number);
    }
  }
  return { orders, buyerStats, itemStats, staffs: await activeStaffs(user?.company_id), quickSearchContent: await generateQuickSearch() };
}

// PendingShipment(): Amazon orders flagged PendingShipment=1.
export async function preparePendingShipment() {
  const orders = await ordersWhere((q) => q.where('store', '=', 'A').where('PendingShipment', '=', 1));
  const buyerStats: Record<string, string[]> = {};
  const itemStats: Record<string, number> = {};
  for (const o of orders) {
    await attachProductMaps(o.detail);
    for (const i of o.detail) {
      (buyerStats[String(o.email ?? '')] ??= []).push(o.orderId as string);
      const k = String(i.asin ?? '');
      itemStats[k] = k in itemStats ? itemStats[k] + (i.qty as number) : (i.qty as number);
    }
  }
  return { orders, buyerStats, itemStats, quickSearchContent: await generateQuickSearch() };
}

// PackingList(): only orders whose every line has a ProductMap -> Product.
export async function preparePackingList(user: User) {
  const buyerStats: Record<string, string[]> = {};
  const itemStats: Record<string, number> = {};
  const packOrders: Order[] = [];

  const consider = async (o: Order) => {
    const lines = o.detail.length;
    const toAdd: Row[] = [];
    await attachProductMaps(o.detail);
    for (const i of o.detail) {
      pushBuyer(buyerStats, o);
      const pm = i['ProductMap'] as Row | null;
      const product = pm?.['Product'] as Row | null | undefined;
      if (pm != null && product != null) {
        toAdd.push(i);
        const sku = String(pm.sku ?? '');
        itemStats[sku] = sku in itemStats ? itemStats[sku] + (i.qty as number) : (i.qty as number);
        if (i.image == null || i.image === '') {
          const images = await db.selectFrom('os_product_images').select('filename').where('product_id', '=', String(product.id) as never).execute();
          if (images.length > 0) i.image = images[0].filename;
        }
      }
    }
    if (toAdd.length === lines) packOrders.push(o);
  };

  for (const o of await ordersWhere((q) => q.where('store', '<>', 'W').where('status', 'is', null))) await consider(o);

  // Walmart: fold consecutive identical lines first (the PHP does this in a separate pass over the same orders).
  const walmart = await ordersWhere((q) => q.where('store', '=', 'W').where('status', 'is', null));
  for (const o of walmart) if (o.detail.length > 1) mergeConsecutiveDetail(o.detail);
  for (const o of walmart) await consider(o);

  return { orders: packOrders, buyerStats, itemStats, staffs: await activeStaffs(user?.company_id), quickSearchContent: await generateQuickSearch() };
}

// Carbon::now()->addMonths(-6) (PHP month overflow: Aug 31 - 6 months = Mar 3).
function sixMonthsAgo(): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.APP_TIMEZONE ?? 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const d = new Date(Date.UTC(g('year'), g('month') - 1 - 6, g('day'), g('hour'), g('minute'), g('second')));
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function withDetailAndTracking(orders: Row[]): Promise<Order[]> {
  const ids = orders.map((o) => o.orderId as string);
  const details = ids.length ? await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', ids).execute() : [];
  const trackings = ids.length ? await db.selectFrom('os_trackings').selectAll().where('orderId', 'in', ids).execute() : [];
  return orders.map((o) => ({ ...o, detail: details.filter((d) => d.orderId === o.orderId), tracking: trackings.filter((t) => t.orderId === o.orderId) }));
}

export async function prepareProcessed() {
  const rows = await db
    .selectFrom('os_grant_order')
    .selectAll()
    .where('status', 'is not', null)
    .where('status', '!=', 'Cancelled')
    .where('created_at', '>', sixMonthsAgo() as never)
    .orderBy('updated_at', 'desc')
    .limit(500)
    .execute();
  return { orders: await withDetailAndTracking(rows) };
}

export function registerListRoutes(app: FastifyInstance): void {
  const withUser = async (req: FastifyRequest) => (await currentUser(req)).user as User;

  any(app, { path: '/allunshipped', name: 'allunshipped', roles: ROLES, handler: async (req, reply) => render(req, reply, 'allunshipped', await prepareAllUnshipped(await withUser(req))) });
  any(app, { path: '/PackingList', name: 'PackingList', roles: ROLES, handler: async (req, reply) => render(req, reply, 'packinglist', await preparePackingList(await withUser(req))) });
  route(app, { verb: 'get', path: '/PendingShipment', name: 'PendingShipment', roles: ROLES, handler: async (req, reply) => render(req, reply, 'PendingShipment', await preparePendingShipment()) });
  route(app, { verb: 'get', path: '/processed', name: 'processed', roles: ROLES, handler: async (req, reply) => render(req, reply, 'processed', await prepareProcessed()) });
  route(app, {
    verb: 'get',
    path: '/summary',
    name: 'summary',
    roles: ROLES,
    handler: async (req, reply) => render(req, reply, 'summary', { summary: await db.selectFrom('os_vwSummary').selectAll().execute() }),
  });
  route(app, {
    verb: 'post',
    path: '/searchOrder',
    name: 'searchOrder',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const orderId = input(req, 'orderId');
      const rows = await db
        .selectFrom('os_grant_order')
        .selectAll()
        .where(sql<boolean>`orderId LIKE ${'%' + String(orderId ?? '') + '%'}`)
        .orderBy('updated_at', 'desc')
        .limit(200)
        .execute();
      return reply.send(await withDetailAndTracking(rows));
    },
  });
  // `view('packing')` has no template in the old app (packing.blade.php is missing) -> always a 500.
  route(app, { verb: 'get', path: '/createPacking', name: 'createPacking', roles: ROLES, handler: async (req, reply) => sendServer500(req, reply) });
  // routes/web.php binds UnshippedController@getUrls, which does not exist (BadMethodCallException) -> 500.
  route(app, { verb: 'get', path: '/geturls', name: 'geturls', roles: ROLES, handler: async (req, reply) => sendServer500(req, reply) });
}
