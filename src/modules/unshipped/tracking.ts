// UnshippedController tracking routes (routes/web.php, all Route::any, role:admin,user,remote).
// UploadTracking -> BatchUploadAmazon -> Amazon::submitFeed is the retired MWS Feeds API (never ported, see
// plan/NOTES.md): it can only fail, so the route answers 500 without any network call.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { paginate } from '../../http.js';
import { any } from '../../router.js';
import { date, render, sendServer500, strtotime } from '../../view.js';
import { saveChanges } from '../../lib/eloquent.js';
import { deductStock } from './orders.js';
import type { Row } from './service.js';

const ROLES = ['admin', 'user', 'remote'];
const json = (reply: FastifyReply, v: unknown) => reply.type('application/json').send(v == null ? '{}' : JSON.stringify(v));
const html = (reply: FastifyReply, body: string) => reply.type('text/html; charset=UTF-8').send(body);
// PHP loose `$x == null`
const looseNull = (v: unknown): boolean => v === null || v === undefined || v === '' || v === 0 || v === false;

async function insertTracking(rec: Row): Promise<void> {
  const ts = nowDb();
  // SAFETY: Tracking columns are bound by Kysely; timestamps are written verbatim like Eloquent's insert.
  await db.insertInto('os_trackings').values({ ...rec, created_at: ts, updated_at: ts } as never).execute();
}


// urldecode(): '+' is a space, %XX bytes (bad escapes stay literal).
function phpUrldecode(s: string): string {
  return s.replace(/\+/g, ' ').replace(/(%[0-9a-fA-F]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}
// UnshippedController::json_clean_decode(): strips /* */ and whitespace-led // comments, then json_decode.
function jsonCleanDecode(s: string): Record<string, unknown> | unknown[] | string | number | boolean | null {
  const stripped = s.replace(/(\/\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+\/)|([\s\t](\/\/).*)/g, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

export function registerTrackingRoutes(app: import('fastify').FastifyInstance): void {
  any(app, {
    path: '/updateEbayTracking',
    name: 'updateEbayTracking',
    roles: ROLES,
    handler: async (req, reply) => {
      await insertTracking({
        store: 'E',
        orderId: input(req, 'orderId') ?? null,
        tracking: input(req, 'tracking') ?? null,
        Url: input(req, 'url') ?? null,
        stampsTxId: input(req, 'stampsTxId') ?? null,
      });
      return json(reply, 'OK');
    },
  });

  // $order[...]: the MWS submitFeed call is commented out in the PHP; only the DB work remains.
  any(app, {
    path: '/updateAmzTracking',
    name: 'updateAmzTracking',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = input(req, 'orderId');
      // $rate['ServiceType'] (the value is only used for an unused $serviceType): a missing/invalid rate or key is a
      // notice that Laravel turns into an ErrorException, before any DB work.
      const rate = jsonCleanDecode(phpUrldecode(String(input(req, 'rate') ?? '')));
      if (rate == null || typeof rate !== 'object' || Array.isArray(rate) || !('ServiceType' in rate)) throw new Error('Undefined index: ServiceType');
      const order = (await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', String(orderId ?? '')).limit(1).executeTakeFirst()) as Row | undefined;
      if (!order) return html(reply, '');
      await insertTracking({ orderId: orderId ?? null, store: 'A', tracking: input(req, 'tracking') ?? null, Url: input(req, 'url') ?? null, stampsTxId: input(req, 'stampsTxId') ?? null });
      await saveChanges('os_grant_order', order, { status: 'Done', updated_at: nowDb() });
      return json(reply, 'ok');
    },
  });

  any(app, {
    path: '/uploadAmzTracking',
    name: 'uploadAmzTracking',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = String(input(req, 'orderId') ?? '');
      const order = (await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', orderId).limit(1).executeTakeFirst()) as Row | undefined;
      if (!order) return json(reply, 0);
      await insertTracking({ orderId, store: 'A', tracking: input(req, 'tracking') ?? null });
      await saveChanges('os_grant_order', order, { status: 'submit', updated_at: nowDb() });
      await deductStock(orderId);
      return json(reply, 'ok');
    },
  });

  any(app, { path: '/UploadTracking', name: 'UploadTracking', roles: ROLES, handler: async (req, reply) => sendServer500(req, reply) });

  any(app, {
    path: '/SearchTracking',
    name: 'SearchTracking',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = input(req, 'orderId');
      const tracking = input(req, 'tracking');
      let rows: unknown[] = [];
      if (orderId != null && String(orderId).length > 2) {
        rows = await db.selectFrom('os_trackings').selectAll().where(sql<boolean>`orderId LIKE ${'%' + String(orderId) + '%'}`).orderBy('created_at', 'desc').limit(10).execute();
      } else if (tracking != null && String(tracking).length > 2) {
        rows = await db.selectFrom('os_trackings').selectAll().where('tracking', '=', String(tracking)).orderBy('created_at', 'desc').limit(10).execute();
      }
      return json(reply, rows);
    },
  });

  any(app, {
    path: '/trackings',
    name: 'trackings',
    roles: ROLES,
    handler: async (req, reply) => render(req, reply, 'trackings', { trackings: await db.selectFrom('os_trackings').selectAll().orderBy('created_at', 'desc').limit(200).execute() }),
  });

  any(app, {
    path: '/trackingsAjax',
    name: 'trackingsAjax',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      let q = db.selectFrom('os_trackings').selectAll();
      const sort = input(req, 'sort');
      if (sort != null && sort !== '') {
        // list($sortCol, $sortDir) = explode('|', $request->sort): a missing '|' is an undefined-offset notice -> ErrorException (500).
        const parts = String(sort).split('|');
        if (parts.length < 2) throw new Error('Undefined offset: 1');
        q = q.orderBy(sql.ref(parts[0]), parts[1].toLowerCase() === 'asc' ? 'asc' : 'desc'); // 5.4 orderBy(): non-'asc' means desc
      } else {
        q = q.orderBy('created_at', 'desc');
      }
      const filter = input(req, 'filter');
      if (filter !== undefined) {
        const value = `%${filter ?? ''}%`;
        q = q.where((eb) => eb.or([eb('orderId', 'like', value), eb('tracking', 'like', value)]));
      }
      const perPageIn = input(req, 'per_page');
      const perPage = perPageIn != null && perPageIn !== '' ? parseInt(String(perPageIn), 10) || 0 : 15;
      // Same headers as the old route (parity); with a wildcard origin browsers never expose the response to credentialed cross-site reads.
      reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Methods', 'GET');
      return json(reply, await paginate(q as never, perPage, req));
    },
  });

  // print_r(delete count)
  any(app, {
    path: '/removeTracking',
    name: 'removeTracking',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = input(req, 'orderId');
      const q = db.deleteFrom('os_trackings');
      const res = await (orderId == null ? q.where('orderId', 'is', null) : q.where('orderId', '=', String(orderId))).executeTakeFirst();
      return html(reply, String(res.numDeletedRows));
    },
  });

  any(app, {
    path: '/scanform',
    name: 'scanForm',
    roles: ROLES,
    handler: async (req, reply) => {
      const prior = date('Y-m-d H:i:s', strtotime(' - 5 days'));
      const orders = await db
        .selectFrom('os_grant_order')
        .selectAll()
        .where((eb) => eb.or([eb('PendingShipment', 'is', null), eb('PendingShipment', '!=', 1)]))
        .where('created_at', '>', prior as never)
        .orderBy('created_at', 'desc')
        .execute();
      const ids = orders.map((o) => o.orderId as string);
      const trackings = ids.length ? await db.selectFrom('os_trackings').selectAll().where('orderId', 'in', ids).execute() : [];
      const info: Row[] = [];
      for (const o of orders) {
        for (const t of trackings.filter((x) => x.orderId === o.orderId)) {
          if (!looseNull(t.stampsTxId) && looseNull(t.canceled) && looseNull(t.voided)) {
            info.push({ orderId: o.orderId, store: o.store, tracking: t.tracking, stampsTxId: String(t.stampsTxId).replace(/[a-z]/g, (c) => c.toUpperCase()), buyer: o.buyer, created_at: t.created_at });
          }
        }
      }
      return render(req, reply, 'scanform', { info });
    },
  });
}
