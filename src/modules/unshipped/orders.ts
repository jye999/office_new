// UnshippedController order actions (routes/web.php:175-195, role:admin,user,remote): notes, made/progress,
// priority, done, assign, ship date, tracking submit (updateOrder), cache helpers.
// Eloquent ->save() semantics come from lib/eloquent.ts (dirty attributes only; updated_at stamped).

import type { FastifyReply, FastifyRequest } from 'fastify';
import { Redis as IORedis } from 'ioredis';
import { db, nowDb } from '../../db.js';
import { config } from '../../config.js';
import { input } from '../../http.js';
import { any, route } from '../../router.js';
import { render } from '../../view.js';
import { saveChanges } from '../../lib/eloquent.js';
import { storeLabel } from '../../lib/labels.js';
import { trigger } from '../../pusher.js';
import { attachProductMaps, type Row } from './service.js';

const ROLES = ['admin', 'user', 'remote'];
// response()->json($x): strings stay JSON strings, null becomes {} (JsonResponse swaps null for an ArrayObject).
const json = (reply: FastifyReply, v: unknown) => reply.type('application/json').send(v == null ? '{}' : JSON.stringify(v));
const html = (reply: FastifyReply, body: string) => reply.type('text/html; charset=UTF-8').send(body);
const phpInt = (v: unknown): number => {
  const m = /^\s*[+-]?\d+/.exec(String(v ?? ''));
  return m ? parseInt(m[0], 10) : 0;
};
// PHP: `Call to a member function save() on null` / property write on null -> ErrorException -> 500.
function must<T>(v: T | undefined | null, what: string): T {
  if (v == null) throw new Error(`${what} not found`);
  return v;
}

// GrantOrderDetail::where('itemId', x)->first() ?: where('id', intval(x))->first()
async function detailByItemOrId(orderId: unknown): Promise<Row | undefined> {
  const byItem = await db.selectFrom('os_grant_orderdetail').selectAll().where('itemId', '=', String(orderId ?? '')).limit(1).executeTakeFirst();
  return (byItem ?? (await db.selectFrom('os_grant_orderdetail').selectAll().where('id', '=', phpInt(orderId)).limit(1).executeTakeFirst())) as Row | undefined;
}
async function orderByIdOrKey(orderId: unknown): Promise<Row | undefined> {
  const byOrder = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', String(orderId ?? '')).limit(1).executeTakeFirst();
  return (byOrder ?? (await db.selectFrom('os_grant_order').selectAll().where('id', '=', phpInt(orderId)).limit(1).executeTakeFirst())) as Row | undefined;
}

// made/progress toggle: set `status` unless it is already set, in which case clear it.
async function toggleMade(req: FastifyRequest, reply: FastifyReply, status: 'Y' | 'H' | 'P'): Promise<void> {
  const orderId = input(req, 'orderId');
  const od = must(await detailByItemOrId(orderId), 'order detail');
  const on = status === 'P' ? 2 : 1;
  if (od['made'] !== status) {
    await saveChanges('os_grant_orderdetail', od, { made: status });
    await trigger('angel-channel', 'change-progress', { orderId, status: on });
    return json(reply, String(on));
  }
  await saveChanges('os_grant_orderdetail', od, { made: null });
  await trigger('angel-channel', 'change-progress', { orderId, status: 0 });
  return json(reply, '0');
}

let redis: IORedis | null = null;
const cacheRedis = (): IORedis => (redis ??= new IORedis({ host: config.REDIS_HOST, port: config.REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 }));

export function registerOrderActionRoutes(app: import('fastify').FastifyInstance): void {
  any(app, {
    path: '/submittedOrder',
    name: 'submittedOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const orders = await db.selectFrom('os_grant_order').selectAll().where('status', '=', 'submit').execute();
      const ids = orders.map((o) => o.orderId as string);
      const details = ids.length ? await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', ids).execute() : [];
      const trackings = ids.length ? await db.selectFrom('os_trackings').selectAll().where('orderId', 'in', ids).execute() : [];
      return render(req, reply, 'submitted', {
        orders: orders.map((o) => ({ ...o, detail: details.filter((d) => d.orderId === o.orderId), tracking: trackings.filter((t) => t.orderId === o.orderId) })),
      });
    },
  });

  any(app, {
    path: '/getOrder',
    name: 'getOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const o = await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', String(input(req, 'orderId') ?? '')).limit(1).executeTakeFirst();
      if (!o) return json(reply, null);
      const detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', o.orderId).execute();
      return json(reply, { ...o, detail });
    },
  });

  // Cache 'unshipped_items' is never written anywhere in the app (only read here), so there is nothing to remove.
  any(app, { path: '/removeOrderFromCache', name: 'removeOrderFromCache', roles: ROLES, handler: async (_req, reply) => html(reply, '') });

  any(app, {
    path: '/madeOrder',
    name: 'madeOrder',
    roles: ROLES,
    handler: async (req, reply) => toggleMade(req, reply, input(req, 'status') === 'halfmade' ? 'H' : 'Y'),
  });
  any(app, { path: '/progressOrder', name: 'progressOrder', roles: ROLES, handler: async (req, reply) => toggleMade(req, reply, 'P') });

  any(app, {
    path: '/updateOrder',
    name: 'updateOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const store = input(req, 'store');
      const orderId = String(input(req, 'orderId') ?? '');
      const tracking = String(input(req, 'tracking') ?? '').replace(/\s+/g, '');
      const url = input(req, 'url');
      const stampsTxId = input(req, 'stampsTxId');
      const pendingToship = input(req, 'pendingToship');
      const amount = input(req, 'amount');
      const serviceType = input(req, 'serviceType');
      const ts = nowDb();
      const rec: Row = { store: store ?? null, orderId, tracking };
      if (url != null && String(url).trim().length > 0) {
        rec['Url'] = url;
        rec['localUrl'] = await storeLabel(orderId, String(url)); // `catch (exception $e)` never matches in the PHP: errors propagate
      } else {
        rec['Url'] = '';
        rec['localUrl'] = '';
      }
      if (amount != null) rec['Amount'] = amount;
      rec['stampsTxId'] = stampsTxId != null ? stampsTxId : '';
      rec['Zone'] = input(req, 'zone') ?? null;
      rec['Rate'] = input(req, 'rate') ?? null;
      rec['DiscountedRate'] = input(req, 'discountedRate') ?? null;
      if (serviceType != null && serviceType !== '') rec['service_type'] = serviceType;
      rec['updated_at'] = ts;
      rec['created_at'] = ts;
      // SAFETY: Tracking columns vary by deployment (service_type may be absent); values bound by Kysely.
      await db.insertInto('os_trackings').values(rec as never).execute();

      const order = (await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', orderId).limit(1).executeTakeFirst()) as Row | undefined;
      if (!order) return reply.send({ status: 'failed', orderId: 'not found' });
      const changes: Row = { status: 'submit', updated_at: nowDb() };
      if (pendingToship != null && pendingToship !== '') changes['PendingShipment'] = 1;
      await saveChanges('os_grant_order', order, changes);
      const details = (await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', orderId).execute()) as Row[];
      await attachProductMaps(details);
      for (const i of details) {
        const pm = i['ProductMap'] as Row | null;
        // PHP loose `qty != null`: null, 0 and '' skip the stock deduction.
        if (pm != null && pm['qty'] != null && pm['qty'] !== 0 && pm['qty'] !== '' && pm['Product'] != null) {
          const locs = (pm['Product'] as Row)['locations'] as Row[];
          for (const l of locs) {
            if (Number(l['qty']) > Number(pm['qty'])) {
              await saveChanges('os_product_locations', l, { qty: Number(l['qty']) - Number(i['qty']) * Number(pm['qty']) });
              break;
            }
          }
        }
      }
      return reply.send({ status: 'ok', orderId });
    },
  });

  any(app, {
    path: '/saveOrderShipDate',
    name: 'saveOrderShipDate',
    roles: ROLES,
    handler: async (req, reply) => {
      const p = must((await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', String(input(req, 'orderId') ?? '')).limit(1).executeTakeFirst()) as Row | undefined, 'order');
      return reply.send(await saveChanges('os_grant_order', p, { planShipDate: input(req, 'date') ?? null }));
    },
  });

  any(app, {
    path: '/assignOrder',
    name: 'assignOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = String(input(req, 'orderId') ?? '');
      const subOrderId = input(req, 'subOrderId');
      let q = db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', orderId);
      if (subOrderId != null && subOrderId !== '') q = q.where('subOrderId', '=', String(subOrderId));
      const p = must((await q.limit(1).executeTakeFirst()) as Row | undefined, 'order detail');
      return reply.send(await saveChanges('os_grant_orderdetail', p, { assignedTo: input(req, 'name') ?? null }));
    },
  });

  any(app, {
    path: '/priorityOrder',
    name: 'priorityOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const hp = input(req, 'hp');
      const od = must(await orderByIdOrKey(input(req, 'orderId')), 'order');
      await saveChanges('os_grant_order', od, { priority: hp ?? null });
      // PHP loose ==: '1' == 1, but also 1.0, '1.0' ...
      const n = Number(hp);
      return json(reply, hp != null && n === 1 ? 'Prioritize' : hp != null && n === 2 ? 'Urgent' : '');
    },
  });

  any(app, {
    path: '/saveOrderNotes',
    name: 'saveOrderNotes',
    roles: ROLES,
    handler: async (req, reply) => {
      const od = must(await detailByItemOrId(input(req, 'orderId')), 'order detail');
      await saveChanges('os_grant_orderdetail', od, { notes: input(req, 'notes') ?? null });
      return json(reply, 'ok');
    },
  });

  any(app, {
    path: '/doneOrder',
    name: 'doneOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const od = await orderByIdOrKey(input(req, 'orderId'));
      if (!od) return json(reply, 'error');
      await saveChanges('os_grant_order', od, { status: 'Done', updated_at: nowDb(), PendingShipment: 0 });
      return json(reply, 'ok');
    },
  });

  any(app, {
    path: '/getPriority',
    name: 'getPriority',
    roles: ROLES,
    handler: async (req, reply) => {
      const od = await orderByIdOrKey(input(req, 'orderId'));
      return od ? reply.send(od) : html(reply, '');
    },
  });

  // Cache::flush() on the redis store = FLUSHDB: it also drops the old app's sessions and queued jobs (same db 0).
  route(app, {
    verb: 'get',
    path: '/clearCache',
    name: 'clearCache',
    roles: ROLES,
    handler: async (_req, reply) => {
      await cacheRedis().flushdb();
      return html(reply, '');
    },
  });
}
